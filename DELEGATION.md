# Delegation — voice for agentic apps

Some apps are themselves driven by an AI agent: you don't fill a form, you *tell
the app's agent what you want* ("add a beat comparing solar and coal") and it
plans, writes and renders the result. Lines Studio is one; there will be many.

This spec is how `@expert/voice` controls those apps. It extends the manifest and
the provider contract (see PROVIDERS.md) with one new idea: an app can register
its own agent, and our voice layer can **delegate** open-ended intent to it
instead of trying to execute it.

---

## The problem: two surfaces, not one

An agentic app exposes two very different kinds of capability.

- **Deterministic shell / control** — navigate to a deck, next/prev beat, Present,
  Download, Stop, Approve, Share, upload a file. A fixed, enumerable set. This is
  exactly the manifest's existing `queries` / `actions` / `routes`; our widget
  executes it directly.
- **Open-ended creative intent** — "add a beat about X", "make the numbers 15%
  bigger", "this logo should draw itself on". This is **not an operation we can
  execute**. Only the app's own agent knows how to turn it into work.

Voice has to drive the first and **hand the second to the app's agent**.

## The principle: router in front, worker behind

Our voice layer stays a thin **dispatcher + narrator**. The app's agent is the
only brain doing the creative work. We never run a second planner competing over
the same job.

> Our agent decides *shell vs delegate* and phrases the instruction; their agent
> does the work; we narrate its progress back by voice. That is the whole contract.

The routing is the voice model's own judgement, informed by a description of what
the sub-agent does — not a separate classifier. Delegation is just another tool
the model can call (see "The `ask` tool").

---

## The `agents` manifest type

A fourth top-level entity, beside `queries`, `actions` and `routes`:

```ts
interface AgentEntry {
  id: string;                 // "deck"
  name?: string;              // a human label for the UI
  // ROUTING CONTEXT. What this agent does AND what it can't -- the "can't" is
  // load-bearing, or ambiguous turns ("go to the next one") get mis-delegated.
  description: string;

  transport: "ui" | "api";    // how an instruction is delivered (default "ui")
  ui?:  UiBinding;            // required when transport === "ui"
  api?: ApiBinding;          // required when transport === "api"

  requiresConfirmation?: boolean; // gate before any delegated turn (see Safety)
  group?: string[];          // a topic, same as an operation, on a large manifest
}
```

A manifest can register more than one agent (an app might have a "deck" agent and
a separate "research" agent). Each becomes its own delegate tool.

---

## Two transports

Delegation mirrors how an *operation* reaches the app: through the **UI** (our DOM
actions) or through an **endpoint** (an HTTP request). The trade is the same one
`onAfterAction` exists for — drive the real UI and the app updates itself; call an
endpoint and you have to tell us how the change becomes visible.

### `ui` — drive the app's own chat (preferred default)

The chatbox is just another shell element: type the instruction, send it. Because
we are a normal user of the app's chat, **the turn shows in the app's own UI and
the app's own hooks fire for free** — streaming, rendering, post-turn refresh.
Nothing to wire.

```ts
interface UiBinding {
  input: string;       // selector for the chat input (textarea / contenteditable)
  send?: string;       // selector for the send control; omit to send with Enter
  transcript?: string; // selector for where replies render -- we READ this to
                       // narrate progress and to keep the router in sync for
                       // follow-ups ("make it bigger" => the last thing it made)
  done?: ReadySignal;  // how to tell the turn finished (readyWhen-style; see below)
  attach?: string;     // optional: the upload control, so "use this logo" can work
}
```

### `api` — call the agent endpoint

For an app that would rather expose its agent programmatically (a stable seam, no
dependence on the chat DOM). The manifest declares where to send the instruction
and how progress comes back:

```ts
interface ApiBinding {
  endpoint: string;                 // POST { instruction, context } here
  stream?: "sse" | "ndjson" | "none"; // how progress streams back (default "sse")
  method?: string;                  // default "POST"
}
```

The catch is the same one HTTP operations have: a programmatic turn is **invisible
by default**. Unlike driving the chat, nothing appears in the app's UI and no
refresh fires on its own. So — exactly as we ask for `onAfterAction` after an HTTP
write — we ask the host for a **reflect hook** that makes the turn visible and
updates the app (see "The reflect hook"). Without it, we can still *narrate* the
turn by voice, but it won't appear in the app's own chat.

### Which to use

| | `ui` (drive the chat) | `api` (call the endpoint) |
|---|---|---|
| deliver instruction | type into chat + send | POST to `endpoint` |
| shows in the app's chat | **yes, free** | only via the reflect hook |
| app's own hooks / refresh | **fire naturally** | you wire them (`onDelegate`) |
| progress to narrate | read `transcript` | the endpoint's stream |
| completion | `done` signal | the stream's `done` event |
| robustness | depends on a stable chat DOM | explicit and robust |
| use when | the default — any app with a chat UI | you own the agent route and want a hard seam |

Prefer `ui`. Reach for `api` when the chat DOM is unstable (virtualised message
lists, a third-party chat widget) or when the app wants a contract that doesn't
break on a restyle.

---

## The `ask` tool — how it reaches the provider

Each registered agent is projected into the tool catalog as one tool:

```
ask_<id>({ instruction })        // e.g. ask_deck({ instruction: "..." })
```

or, equivalently, a single `ask({ agent, instruction })`. Its **description is the
agent's `description`**, so the voice model routes to it by understanding what the
sub-agent is for — the same way it chooses any tool. A shell command matches a
shell operation; an open-ended request matches `ask_<id>`; the model decides.

Execution follows the transport:

- `ui` — the core types `instruction` into `input`, sends, watches `done`, and
  reads `transcript` as it fills, forwarding lines to `onTranscript` / `onActivity`
  so the user hears progress.
- `api` — the core POSTs `{ instruction, context }` to `endpoint`, consumes the
  stream, narrates it, and calls the reflect hook so the app shows the turn.

`context` carries what the widget can see that the agent can't infer from the
words alone — the current route, and (when asked about something on screen) the
current frame or the element under discussion. This is how "the number top-right
is too big" delegates the instruction *plus* the state, the voice analogue of the
app's own annotate-a-frame feature.

Either way it is just a tool call: `onToolCall("ask_deck", { instruction })` fires,
the core runs the delegation, and the provider never has to know an agent is
involved — exactly as it never knows a dialog or a DOM step is involved.

---

## Tracking a turn: `done` and `transcript`

A delegated turn is long and streaming (Lines Studio turns run many steps). Two
signals keep the voice layer in step, both generalisations of things we already
have.

**`done` — a readiness signal, generalised from pages to turns.** Our `readyWhen`
already answers "is this page ready?"; `done` answers "is this agent turn
finished?". Same shape — a marker that appears, a control that re-enables, a state
that settles:

```ts
type ReadySignal =
  | { appears: string }     // a selector that shows up when the turn is done
  | { enabled: string }     // a control (the send button) that re-enables
  | { gone: string }        // a running indicator that disappears
  | { settles: true };      // the transcript stops changing for a beat
```

Until `done` fires, we hold the floor ("working on that…"); when it fires we
narrate the result and let the next turn land. For `api`, the stream's own `done`
event plays this role.

**`transcript` — read the conversation, don't fork it.** The sub-agent's chat is
stateful and shared. Our router must *read* it — not start a parallel
conversation — so that follow-ups route correctly and we narrate what actually
happened. This is why `ui` is powerful: reading the native transcript is free, and
it is the single thing that keeps a thin router grounded.

---

## The reflect hook (the `api` analogue of `onAfterAction`)

When delegation goes through `api`, the host provides a callback so the turn is
reflected in the app's own UI and the app updates — the same role `onAfterAction`
plays for an HTTP write:

```ts
// a VoiceProvider prop
onDelegate?: (event: {
  agent: string;
  instruction: string;
  phase: "start" | "progress" | "done" | "error";
  text?: string;        // streamed assistant output, on "progress"
  result?: unknown;     // on "done"
}) => void;
```

A typical host renders the user instruction into its chat on `start`, appends
streamed text on `progress`, and triggers its normal post-turn refresh on `done`.
Absent, delegation still works and still narrates by voice — it simply won't appear
in the app's own chat, which is why `ui` is the default.

(An escape hatch for hosts that want full control: a `delegateAdapters[id]`
function prop that both talks to the agent and reflects into the UI, replacing the
manifest's `api` binding. Same idea, imperative instead of declarative.)

---

## Writing a good agent description (the judgement pass)

The `description` is what makes routing work, so it gets the same care the
judgement pass gives an operation (see the skill). Two rules:

- **Say what it does, in a user's words** — what you can ask it for.
- **Say what it CAN'T do**, naming the shell actions that look similar. "It builds
  and edits the deck. It does NOT navigate, present or download — those are shell
  actions." Without the second line, "go to the next one" is a coin flip between
  the deck agent and the next-beat control.

Keep the router thin. Its only jobs are classify-and-phrase and narrate. The moment
it starts reasoning about deck content, you have two brains and the design is lost.

---

## Safety

A delegated instruction can be destructive ("delete this deck"), and our
confirmation gate — which understands *our* operations — can't read the semantics
of a free-text instruction. Two options:

- **Gate coarsely at the delegate boundary**: set `requiresConfirmation` on the
  agent entry, or detect delete-ish language, and confirm once before sending
  ("You're about to ask the deck agent to delete a deck — go ahead?").
- **Let the app's own agent confirm**: because `ui` drives the native chat, the
  sub-agent's own "are you sure?" surfaces in its UI, and the user can answer it by
  voice. The UI transport makes this the natural path.

Delegation never widens what the app's agent could already do; it only gives it a
voice. The key never leaves the host: the sub-agent holds its own model key
(server-side), our provider holds its own — two server halves, both the host's,
the same BYOK story as everywhere else.

---

## Worked example: Lines Studio

Lines Studio's deck is built by an agent you talk to in a chat panel, with an
SSE-streamed turn. Registered with the `ui` transport:

```json
{
  "agents": [
    {
      "id": "deck",
      "name": "Deck builder",
      "description": "Builds and edits the animated slide deck: add, change, remove or restyle beats, fix a visual, adjust pacing. Ask in plain language ('add a beat comparing solar and coal', 'make the numbers 15% bigger'). It does NOT navigate the app, present, download or share — those are shell actions.",
      "transport": "ui",
      "ui": {
        "input": "[data-chat-input]",
        "send": "[data-chat-send]",
        "transcript": "[data-chat-log]",
        "done": { "gone": "[data-turn-running]" },
        "attach": "[data-chat-attach]"
      }
    }
  ],
  "routes": [ /* deck pages, gallery, present — the shell */ ],
  "actions": [ /* next/prev beat, download, share, stop — the shell */ ]
}
```

A session then routes naturally: "go to the fission example" → a route; "next
beat" → a shell action; "add a beat about breeder reactors" → `ask_deck`, typed
into the real chat, the turn visible and streaming in Lines Studio's own panel,
narrated by voice, and when `[data-turn-running]` disappears the preview reloads
because the app's own code did it.

---

## How it fits the rest of the system

- **Core owns delegation**, like every other execution. `ask_<id>` runs in the
  executor (drive-the-chat or call-the-endpoint + reflect); the confirmation gate
  wraps it; the provider only ever proposes it. Nothing about delegation lives in
  a provider.
- **Providers are unchanged.** `ask_<id>` is one more tool in the catalog; a
  realtime model calls it by judgement. See PROVIDERS.md.
- **The manifest stays the single source.** Agents are generated/declared the same
  way operations are, refined by the same judgement pass, and projected to the
  neutral tool catalog like everything else.

## Status

- **Shipped (the `ui` transport):** the `agents` manifest type (preserved through
  the relay and listed in the prompt), a single `ask({ agent, instruction })` tool
  emitted only when an agent is registered, and `dom.delegate()` — types into the
  app's chat, sends, waits for the `done` signal (`appears`/`gone`/`enabled`/
  `settles`), and reads the reply back. Driven in a real browser by
  `test/dom.test.mjs`.
- **Next:** the `api` transport + the `onDelegate` reflect hook; `requiresConfirmation`
  gating for a delegated turn; and router-quality work (reading the transcript to route
  follow-ups, richer "what this agent can't do" descriptions).
