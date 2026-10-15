---
name: expert-voice
description: Set up and maintain @expert/voice for an app — generate the manifest from source, probe it against the running app, then run the judgement pass that turns flagged operations into real descriptions and tiers and makes the app's pages navigable (describe them, prune the ones that are not destinations, note how each is reached). Use when adding voice control to an app, or when a voice session misbehaves (silent no-ops, wrong argument shapes, a page read before it loaded, navigation landing on the wrong page).
---

# Using @expert/voice — generate, probe, judge

`@expert/voice` gives an app voice control from a **manifest**: a description of
the app's operations — queries, actions, routes — that the voice agent drives.
This skill is how you BUILD and MAINTAIN that manifest well.

You are the code-literate agent already open with the repo. There is no API key
and no separate model to provision: you run the package's own tools and read the
app's source. That is the whole point.

The manifest is built in three stages, each doing only what it can, in order:

- **Static analysis** (`voice-cli`) finds the operations from source. Exhaustive,
  cheap, and knows nothing about what matters.
- **Probing** (`voice-probe`) confirms them against the running app and measures
  what source cannot — which routes are real, when a page is ready, what a write
  truly requires.
- **The judgement pass** (you) does the one thing neither can: judge which
  operations a person would speak to, what each is FOR in a sentence, and the
  contracts a handler enforces but the schema never states.

## 0. Install — only if the app does not have the packages yet

Check first: `ls node_modules/@expert/voice-cli` from the app root. If it is
there, skip to stage 1. If not, install from the GitHub release (the packages
are not on npm yet, so `npx` alone will NOT find them):

```
REL=https://github.com/OrchestraAssistant/voice/releases/download/v0.1.4
npm install    $REL/expert-voice-0.1.4.tgz          # the widget (runtime)
npm install -D $REL/expert-voice-cli-0.1.4.tgz      # this CLI (build-time tooling)
npm install    $REL/expert-voice-server-0.1.4.tgz   # the backend route (runtime)
```

Use the app's package manager (`yarn add <url>`, `pnpm add <url>`). If the
frontend and backend are separate packages, the widget goes in the frontend and
the server package in the backend. Wiring the widget and mounting the `/voice`
route are in the agent guide:
https://github.com/OrchestraAssistant/voice/blob/main/docs/agent-guide.md

## 1. Generate

From the app root:

```
npx voice-cli [srcDir] [outDir]     # defaults: ./src (or .) -> ./.voice
```

This writes `.voice/manifest.json`. Read the output — every stage that fired,
and every one that found nothing and why. The manifest also carries the
**worklist** for stage 3: the operations it could not fully understand, tagged
`review` / `confidence` / empty `bodyFields` (see stage 3).

## 2. Probe — recommended, and it needs the running app

```
npx voice-probe .voice/manifest.json http://localhost:3000 \
    --login spec.json --browser [--writes] [--effects fixtures.json] [--fix]
```

- `--login spec.json` signs in first (credentials in a FILE, never on the command
  line — they end up in shell history otherwise).
- `--browser` uses a real browser to measure readiness (`readyWhen` markers, so
  navigate waits for a page instead of guessing). Skip it and pages are inferred,
  not confirmed. CI with no browser is fine — the probe says so and carries on.
- `--writes` probes write actions by performing them, so point it at a **seeded,
  throwaway instance**.
- `--effects fixtures.json` verifies a write actually CHANGES state: it sends a
  call and reads the result back. A `2xx` that changed nothing is a silent no-op
  — the most dangerous failure, because it looks like success.
- `--fix` writes what it learned into `.voice/manifest.overlay.json`.

## 3. The judgement pass — where you come in

Static analysis reads structure and probing measures behaviour; neither can
JUDGE. This stage is judgement, done against the app's own source.

### The one rule about where to write

**Never edit `.voice/manifest.json`.** It is regenerated from source and your
edits would be erased. Write into **`.voice/manifest.overlay.json`**, which is
merged last and OUTRANKS the generated file. Patches match by identity: routes
by `path`, queries and actions by `name`. A patch carries only the fields you are
changing, and may carry `"drop": true` to REMOVE a route or endpoint that should
not ship (see pruning, below). Re-running `voice-cli` applies the overlay; the
probe confirms it.

### The worklist is already in the manifest

Do not review all 200 operations. The generator flagged the ones that need you.
Open `.voice/manifest.json` and find:

- **`review` on an operation** — an array of `{ field, kind, reason }`. `kind` is
  `opaque` (a convention rides on a shape — a positional array, an unlabelled
  code), `unknown` (the shape itself is undetermined — `z.any`, or a write whose
  body could not be read), or `truncated` (a nested shape shown only partway).
  **The `reason` points you at the source** — an unresolved schema symbol to
  chase, a hook's form to read, or the handler itself.
- **`confidence: "review" | "unknown"`** — the operation the runtime distrusts.
  `known` is the default and is left off.
- **empty `bodyFields` on a write action** — the input shape was not resolvable.

Those are your list. Everything else the machine already knows well enough.

### The loop, per flagged operation

1. **Read the reason, follow it to the source.** Open that file. Read the
   handler, the schema, the form. Understand what the operation is FOR and what it
   truly requires — including anything the schema lies about.
2. **Write a real `description` into the overlay.** It reaches the model in the
   catalog, so write it FOR the model: what it does, in a sentence, plus any trap
   or convention the model cannot infer. Not "Auto-detected tRPC mutation
   schedule.update" — that is what you are replacing.
3. **Confirm a write with the read-back probe.** Write a fixture holding the
   NATURAL call a model would make, run `voice-probe --writes --effects fx.json`,
   and read the verdict. A `2xx` that changed nothing means the description must
   name the load-bearing field. A verified change earns the operation `known`.
4. **Refine the grouping, if needed.** A large app is already grouped for you: the
   generator clusters operations into topics by entity (read from their names) so
   the base prompt stays small — a 300-operation app drops from ~20k to ~7k tokens,
   everything still reachable via `expand`. Touch `group` by hand only to improve on
   that — clearer topic names, a deliberate tier (`["availability","schedule"]`) — or
   to group a mid-size app the auto-pass left at root. An overlay `group` is the
   floor and is always respected. Give a topic a one-line entry in `groups`.

### The worked example (cal.diy, and why this stage exists)

`availabilityScheduleUpdate` came out flagged `opaque` (a nested array) and its
runtime call kept silently doing nothing. Reading `ScheduleService.ts` shows two
things no schema states:

- The handler does `if (!input.name) return` — **`name` is required in practice**
  though the schema marks it optional. Omit it and the write is a silent no-op.
- `schedule` is a **7-element array, index 0 = Sunday … 6 = Saturday**, each
  element a list of `{ start, end }` windows, `[]` for a closed day.

Neither is extractable; both are judgement. The note that closes it:

```json
{
  "actions": [
    {
      "name": "availabilityScheduleUpdate",
      "group": ["availability", "schedule"],
      "description": "Update a schedule's weekly availability. ALWAYS include `name` (the schedule's current name) — without it the update is silently ignored. `schedule` is a 7-element array, index 0=Sunday..6=Saturday; each element is a list of {start, end} windows, [] for a closed day."
    }
  ],
  "groups": [{ "path": ["availability"], "description": "when you are bookable" }]
}
```

Then a fixture WITH `name` verifies through the probe, and the flag is resolved.

### Say what the app IS

The very first line of the session prompt tells the model what app it is embedded
in. That is the model's strongest anchor, so it must be TRUE: assert "a
task-management app" onto a store and the model invents task lists. The generator
seeds a manifest-level `description` from the app's `package.json`; refine it into
one line written for the model -- what the app is, in the words a user would use:

```json
{ "description": "Plane: an issue and project tracker -- projects, work items, cycles and modules." }
```

A top-level `description` in the overlay outranks the seed. Absent, the prompt
falls back to a neutral "a web app". Get this right before the pages and
operations: it frames everything the model reads after it.

### Pages are part of the manifest too

Navigation is half of voice — "take me to X" — and it fails the same way a bad
action does: the model picks the wrong page, or reaches for one it cannot get to.
The generator does not FLAG pages (there is no schema to distrust), so they are
not on the worklist above — but they need the same judgement, and this is where
you give it.

**Describe every page a person would ask for.** The generator fills a route's
`description` from the page's own title when it can ("Event types"); replace that
with a line that says what the page is FOR, in the words a user speaks — what is
on it and why someone goes there, led by the label the UI uses, so any phrasing
of the goal lands on it:

```json
{
  "routes": [
    {
      "path": "/:workspaceSlug/profile/:userId",
      "description": "Your work: your assigned and created items, your activity and a workload summary — where you check what is on your plate. This is the app's 'Your work' page."
    }
  ]
}
```

Now "show me my work", "what am I working on" and "my tasks" all land here, where
"A member's profile" would have caught none of them.

**Say how a parameterised page is reached.** A route like
`/:workspaceSlug/profile/:userId` has holes only a live value fills. In the
description, note where each comes from — and flag the ones that CANNOT be
resolved:

- `:workspaceSlug` — the widget fills it from the current URL; you need say nothing.
- `:projectId` — the model resolves it; name the query it comes from (`projectsList`).
- `:userId` for "your work" — **no query returns the current user's id**, so the
  URL cannot be built. Say so, and that the page is reached by the on-screen nav
  item rather than by URL. A route the model cannot construct should point it at
  the screen, not send it guessing.

If a page like that is common, the better fix is upstream: add the missing query
— a `usersMe` that returns the signed-in user — so the id becomes resolvable and
the description can name it.

**Prune the routes that are not destinations.** A fresh manifest lists every route
the framework declares — redirect stubs (`/login`, `/sign-in`), catch-alls (`/*`),
auth and onboarding screens, framework not-found pages. A person never asks for
those, and 60 flat routes is 60 wrong turns. Drop them with `drop`:

```json
{
  "routes": [
    { "path": "/*", "drop": true },
    { "path": "/login", "drop": true },
    { "path": "/:workspaceSlug/projects/:projectId/settings/*", "drop": true }
  ]
}
```

What is left is the set of pages a user would name. Group the survivors with
`group`, the same way you group operations (step 4), so the base prompt stays
small.

### The honesty rules

- **Read the source; do not invent.** A guessed description is worse than the
  auto-generated one, because it reads as authoritative. If you cannot determine a
  contract from the code, leave the operation flagged and say so.
- **A description is for the model, not for docs.** Lead with what it does; spend
  the rest only on what the model would otherwise get wrong.
- **Prefer promoting `known` via the probe over asserting it.** A verified
  read-back is proof; your confidence is a guess until it passes.
- **Leave `readyWhen` to the probe** unless you have a reason it got one wrong —
  it measures the running page; you are reading static source.

## When you are done

Re-run `voice-cli` (applies the overlay) and, for the writes you touched, the
read-back probe (confirms them). The flag count should drop, the catalog
descriptions should read like a person wrote them, and a voice session should
stop guessing at the contracts you just wrote down.
