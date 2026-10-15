# Design choices

Decisions that were genuine forks — where the alternative was reasonable and
might become the better answer later. Each records what was chosen, what it
costs, and what would justify revisiting.

Two parts. **Sections 1–5** are about rendering: where the widget draws, and
how its CSS survives a host we don't control. **Sections 6–13** are about the
shape of the realtime session — what goes in the JSON we send to OpenAI, and
what each field costs.

---

## 1. Where the widget mounts: shadow root vs. the host's DOM tree

**Chosen:** all widget chrome renders into a **single open shadow root**
attached to `<body>`, outside the host app's React tree.

**Alternative:** render in the host's tree (`mount="inline"`, still supported
as a switch), and defend our styling with high-specificity selectors.

### Why

A host app's ordinary global CSS reaches an in-tree widget and wins. This
isn't hypothetical — a typical host app, deliberately unremarkable, took the
widget apart on first contact:

```css
/* a host app's index.css — an entirely normal thing for an app to have */
form   { display: flex; flex-direction: column; }
button { padding: 6px 14px; border: 1px solid var(--border); background: #fafafa; }
```

Result: the widget's command input and Send button stacked vertically, and the
tab pills became bordered grey boxes.

Two separate mechanisms make this unwinnable in-tree:

1. **Specificity + source order.** Our base rules are `:where(...) button`,
   which scores 0,0,1 — identical to a bare `button {}`. The host's stylesheet
   loads after ours (verified in the compiled CSS: widget styles at
   char 7386, host styles at 13287), so on every tie the host wins.
2. **Cascade layers outrank specificity.** Tailwind v4 emits utilities into
   `@layer utilities`, and for normal declarations *unlayered* styles beat
   *layered* ones regardless of score. So a host's unlayered `button {}`
   (0,0,1) beats `.bg-foreground/4` (0,1,0) — the utility is more specific and
   still loses.

Raising our own specificity to answer this doesn't work either: it then stomps
the Tailwind utilities the pasted skiper/shadcn components are built from.
That's the trap — every specificity setting is wrong for one of the two.

Inside a shadow root, outer selectors simply **don't match** our nodes, so
neither mechanism applies. The problem stops existing instead of being
rebalanced.

### Open, not closed

The root was closed at first. The difference is narrower than it looks, and it
runs the wrong way.

Closed buys exactly two things over open: `host.shadowRoot` returns `null`,
and `composedPath()` truncates at the boundary — verified in jsdom:

| mode | `composedPath()` length | reveals inner node |
|---|---|---|
| `open` | 8 | yes |
| `closed` | 5 | no |

Everything the isolation is actually *for* survives either way. Outside CSS
still cannot select in. `document.querySelectorAll` does not descend into an
open root either, so our own `dom_snapshot` / `dom_click` fallback still never
sees the widget's chrome as page content. Inherited properties still cross.

What closed cost was larger:

- Click-outside could use neither `contains()` nor `composedPath()`, so it ran
  off `event.target === overlayHost`. Reliable, but a third branch that cost
  two broken iterations before it was understood. Open deletes it.
- The configuration that ships became unreachable by devtools, selectors and
  tests. That is not neutral: a resize fix was verified at `mount="inline"`,
  looked complete, and was broken in every build that shipped. Nothing could
  see it.
- It was never a security boundary. A host that wants in patches
  `Element.prototype.attachShadow` before our script loads. That is six lines,
  and it is exactly what the harness had to do to become inspectable. If a
  customer's security review ever demands real isolation, the honest answer is
  an iframe, not a closed root.

### What it costs

- **Event retargeting.** Events crossing the boundary still have
  `event.target` rewritten to the shadow host, open or not. Anything reading
  `target` from a document-level listener has to read `composedPath()`
  instead.
- **Runtime-injected stylesheets land in the wrong tree.** A library that
  injects a `<style>` into `document.head` at runtime has no effect on our
  nodes, and fails *silently* — no error, no warning, just a rule that never
  matches. framer-motion's `AnimatePresence mode="popLayout"` is exactly this:
  it takes the outgoing child out of flow with an injected
  `[data-motion-pop-id] { position: absolute !important }` block, so inside
  the shadow root the outgoing pane stayed in flow and the panel animated to
  the *sum* of both panes' heights (188 + 210 = 398) before snapping back.
  It behaved perfectly at `mount="inline"` throughout.

  The fix is one prop — `AnimatePresence` takes `root?: HTMLElement |
  ShadowRoot` and appends there instead (`const parent = root ?? document.head`
  in its `PopChild`) — but finding it meant reading framer-motion's source.
  Note that it points *both* ways: handing that same `root` to the panel while
  it was mounted `inline` reproduced the identical bug in the other direction,
  styling a tree its panes were not in. `useOverlayLayer` therefore returns
  `root` and `container` together or neither, so no caller can hold a root
  that doesn't match where it renders.
  **The general lesson is the one to keep:** a fix verified only at
  `mount="inline"` is not verified. Anything that injects styles, measures
  against `document`, or looks up an element by id needs checking in the
  root, which is what `dev/bubble.html?mount=shadow` is for.
- Focus, `aria-*` relationships, and form participation don't cross the
  boundary for free.
- **One root, not one per component.** The rim and the panel used to mount
  their own overlay each, which meant two elements competing for a top layer
  that is a plain stack: last to `showPopover()` paints last. Neither could
  concede without a rule, and each re-raising itself when the other appeared
  was a feedback loop — our raise fires a `toggle`, the other answers with a
  raise, measured at ~1800 events a second and seen as the panel flickering
  above and below the rim. They now share one host with an ordered layer
  each, so paint order is DOM order, decided once, and the question stops
  existing rather than being arbitrated at runtime. The cost is that
  `VoiceProvider` mounts the overlay, so chrome can no longer be used entirely
  standalone; `OverlayProvider` is exported for harnesses that want the
  overlay without a session.
- Host tooling and any library that queries `document` can't see inside.
- Inherited properties (`color`, `font`) *do* still cross, so isolation is of
  rules, not of everything.

### Revisit if

- A host is observed reaching into the root and interfering. Closing it again
  would only make that slightly less convenient, so the answer at that point
  is probably the iframe below rather than going back.
- We adopt a component that assumes document-level DOM access.
- We decide prefixed class names (`.iv-transcript`) plus explicit shielding
  is enough, accepting that a host's `button {}` still reaches us.

`mount="inline"` is kept deliberately so the difference stays observable:
compare the default shadow mount against `?mount=inline` in the dev harness.

### Considered and deferred: an iframe

The strongest isolation available, and — as far as we understand it, from
general knowledge rather than verified research — what the established
widget vendors use. Chat messengers (Intercom, Zendesk, Drift) render their
UI in one or more iframes with a small coordinating script in the page.
Payment and captcha embeds (Stripe Elements, reCAPTCHA) do it for a stricter
reason: the host page *must not* be able to read what the user types, so
isolation is the product requirement rather than a styling convenience.

An iframe is strictly stronger than a shadow root:

- separate document *and* separate JS global scope;
- **inherited properties don't cross either** — `color`, `font`,
  `line-height` still leak into our shadow root, and wouldn't here;
- immune to `!important`, ancestor stacking contexts and re-rooted
  containing blocks by construction, not by workaround.

Deferred because of three costs that land specifically hard on this product:

1. **Content can't overflow the frame's box.** A panel that expands, or any
   dropdown that spills past its edge, requires resizing the iframe itself
   from inside over `postMessage`. Much of the complexity in those vendors'
   SDKs is exactly this.
2. **The listening rim is full-viewport.** A transparent full-viewport
   iframe with `pointer-events: none` can host the rim, but then it can't
   receive the panel's clicks either — so it becomes multiple iframes, or
   one that resizes as the panel opens and closes.
3. **Our agent must touch the host's DOM regardless.** `dom_snapshot` /
   `dom_click` / `dom_type` are the whole Tier-1 fallback and can only run
   in the page's context. So an iframe splits us into iframe-UI plus
   page-script, coordinated over `postMessage` — where today the UI and the
   session share React state directly.

The asymmetry worth remembering: a chat widget's UI is self-contained and
never reads the host page, which is what makes an iframe cheap for them.
Ours is closer to a browser extension that happens to have a panel.

**Revisit if** a customer's security review objects to our UI sharing a
JS context with their page (an iframe answers that and a shadow root
doesn't), or if host CSS inheritance — the one thing the shadow root
doesn't stop — turns out to cause real visual bugs in the field.

### Considered and rejected: ID-scoped selectors

The obvious cheaper alternative: give the widget root an `id` and prefix every
rule with it — `#interpreter-widget button { … }`, scoring **1,0,1**. That
beats a host's `button {}` (0,0,1) outright, with no dependence on source
order, and it also stops our styles leaking outward. Pre-shadow-DOM, this is
how embeddable widgets did it, and if we weren't building on Tailwind it would
be the right call: far simpler than a shadow root.

It's specifically incompatible with *this* codebase:

1. **It outranks our own utilities too.** The components are assembled from
   Tailwind classes — `.bg-foreground/4` at 0,1,0. An ID rule beats those by a
   wider margin than it beats the host, so `#interpreter-widget button
   { background: transparent }` kills the selected-tab highlight exactly like
   the `.interpreter-widget button.rounded-2xl` override originally did. The
   bind is structural: **0,0,1 and 0,1,0 are adjacent**, so no specificity
   sits above a host's `button {}` and below a utility class. Any shield
   strong enough to stop the host stops us. Escaping it means marking the
   utilities `!important` (Tailwind v4 supports this), which just relocates
   the fight.
2. **It only defends properties we explicitly declare.** A host's
   `button { text-transform: uppercase }` still lands unless we've written
   `text-transform` ourselves — so it implies hand-rolling a full reset per
   element type (`all: revert` scoped to us). Doable, but open-ended.
3. **`!important` ignores specificity entirely.** `body div { position: static
   !important }` — a real legacy-CSS pattern, and one the stress harness
   deliberately includes — beats any ID. Only inline `!important` (what
   `ScreenOverlay` pins on its host element) or shadow isolation escapes it.
4. **It addresses none of the non-cascade problems.** A transformed or
   `contain: paint` ancestor re-roots `position: fixed` so `inset: 0` stops
   meaning the viewport; an ancestor stacking context caps our z-index at any
   value. Those are layout and paint concerns, not selector matching.

Minor, but worth noting: an `id` must be unique per document, so a host
mounting two widgets breaks it. `[data-x]` scores 0,1,0 (same as a class, so
no help); the `[data-x][data-x]` doubling trick works but is the same
specificity arms race by another name.

**Revisit if** we ever drop Tailwind from the package. Then reason 1 — the
decisive one — disappears, and ID-scoping plus a scoped reset becomes a
genuinely simpler answer than maintaining shadow-boundary workarounds.

---

## 2. Tailwind is a build-time dependency, and preflight is excluded

**Chosen:** author components with Tailwind; compile to plain CSS in
`dist/voice.css`; ship no Tailwind to consumers. Import
`tailwindcss/theme.css` + `utilities.css` only — **never** the full
`@import "tailwindcss"`.

**Why:** preflight is a *global* reset (`*,::before,::after{box-sizing:border-box;margin:0}`,
unstyled headings). Fine for an app that owns the page; catastrophic for a
widget dropped into someone else's, where it would silently restyle their
entire document.

**Cost:** pasted shadcn/skiper components assume preflight exists — buttons
being transparent and borderless is what lets their utility classes compose.
We supply a preflight-equivalent reset scoped to our own roots instead. When a
pasted component looks subtly wrong, this is the first thing to suspect.

**Revisit if:** we move fully into the shadow root, where preflight could be
injected safely, since it could no longer reach the host document.

---

## 3. Theme tokens map through `@theme inline reference`, not `:root`

**Chosen:** `@theme inline reference { --color-background: var(--iv-surface); ... }`,
with the concrete values defined in a rule scoped to the widget's roots.

**Why:** shadcn components are written against `bg-background`, `bg-muted`,
`text-foreground`. Defining `--color-*` values directly on `:root` would
overwrite the same variables in any host that also uses Tailwind v4.

**Why the two modifiers, and not a plain `@theme`:** a plain `@theme` emits
the names to `:root` and has the utilities *reference* them —
`.bg-background { background-color: var(--color-background) }`. That silently
does not work, and it is worth being precise about why, because the failure is
invisible: a custom property whose value contains `var()` is substituted at
**computed-value time on the element it is declared on**, not deferred to
whoever reads it later. On `:root`, `--iv-surface` does not exist, so
`--color-background` computes to the guaranteed-invalid value and *inherits
down in that state*; defining `--iv-surface` further in never gets a second
look. Every semantic utility in the widget resolved to `transparent` /
`unset`. It looked fine only because the panel sat on white hosts — on
`dev/bubble.html?bg=dark` the whole panel is see-through.

- `inline` pastes the value into the utility itself —
  `.bg-background { background-color: var(--iv-surface) }` — so the lookup
  happens at the **use** site, inside our subtree, where `--iv-surface` is
  defined.
- `reference` then stops the (now unreferenced) `--color-*` names being
  emitted to `:root` at all, which is what this section wanted in the first
  place.

**Cost:** the utilities are inert outside our subtree — fine, and arguably
correct, but surprising if someone expects them to work anywhere.

### Related: our own rules live in `@layer base`

Same class of bug, same stylesheet. The scoped preflight-equivalent reset
(`:where(.interpreter-panel, .interpreter-widget) button { background:
transparent }`) was written at zero specificity on the theory that "utilities
always win". They don't: for normal declarations **unlayered beats layered**
regardless of specificity, and Tailwind's utilities are in `@layer utilities`.
So the reset beat `bg-foreground/4` and the selected tab never highlighted.
`@layer theme, base, components, utilities;` up front, with everything of ours
in `base`, puts the two in a defined order — and it is the same mechanism that
makes ID-scoping unworkable in §1.

### Related: the measured wrapper is pinned to the panel width

`useMeasure` watches a wrapper that would otherwise be as wide as the
container animating around it. Collapsed, that container is 56px, so at the
first frame of an open the content wrapped and measured **348px** tall, then
unwrapped to 188 as the width caught up — the panel ballooned and collapsed
instead of just growing. Measuring at the final width (`style={{ width:
PANEL_WIDTH }}`) makes the transition monotonic in all four directions; the
container's `overflow-hidden` does the revealing, and the tab strip is
unaffected because it is absolute against the container, not the wrapper.
The original never hits this because 200 → 290 is too small a change to
rewrap anything. `dev/bubble.html?trace=1` is what this was diagnosed with.

### Related: `@source "./"` is explicit

Tailwind's automatic content detection keys off the *build's* root, not the
stylesheet's. The library build (root `packages/voice`) found `src/`; the dev
server (root `dev/`) silently did not, and served a stylesheet with almost
none of the utilities the components are built from — so the same component
looked correct in one and unstyled in the other. Declaring `@source "./"`
relative to the stylesheet makes the scanned set the same for every consumer.

---

## 4. Dependencies are bundled, not peer

**Chosen:** `framer-motion`, `lucide-react`, `react-use-measure`, `clsx`, and
`tailwind-merge` are bundled into `dist/voice.js`. Only `react`/`react-dom`
are external.

**Why:** React must be external — two copies is the classic "invalid hook
call". The rest are implementation details a customer shouldn't have to
install.

**Cost:** a host already using framer-motion ships it twice. The bundle is
~262KB (~73KB gzipped), and `mode="popLayout"` pulls in framer-motion's
layout-projection code specifically.

**Revisit if:** bundle size becomes a selling point, or telemetry shows most
hosts already have framer-motion.

`usehooks-ts` was deliberately *not* added for a single `useOnClickOutside`;
it's ten lines locally.

---

## 5. Test against a host with no Tailwind, on purpose

**Chosen:** a plain-Vite host with hand-written CSS that consumes
`@expert/voice` exactly as a customer would — no Tailwind of its own.

**Why:** it's the only thing that proves the compiled package stands on its
own in a host that doesn't share our build setup. Adding Tailwind there would
destroy the signal — and it's precisely what caught the collision in §1.

**Revisit if:** never, really. If we want a Tailwind host to test against,
add a *second* one rather than converting this.

---

# Part two: the shape of the realtime session

Sections 1–5 are about rendering — where the widget draws and how its CSS
survives a host we don't control. Everything below is about a single JSON
object: the `session` the relay sends to `/v1/realtime/client_secrets`, plus
the two fields the client changes once the data channel is open.

Almost every field in it was a decision, and most of them were settled by
measurement rather than argument. The numbers cited are from scripted runs
against a host app with a fake capture device, logged off the data channel;
`packages/voice/dev/bubble.html` and the git history have the machinery. They
are single runs of a nondeterministic model, so read the orderings as solid
and the exact figures as approximate.

As it stands:

```jsonc
{
  "type": "realtime",
  "model": "gpt-realtime",            // §6 — should be pinned, see below
  "instructions": "...",              // §11 — terse by measurement
  "tools": [ /* 13, manifest-derived */ ],
  "tool_choice": "auto",
  "audio": {
    "output": { "voice": "marin" },
    "input": {
      "transcription": { "model": "gpt-live-transcribe" },  // §8
      // language omitted unless the user picked one       — §7
      // turn_detection omitted, so server_vad applies     — §10
    }
  }
}
```

---

## 6. Model: pin the version, and not the mini alias

**Chosen:** `gpt-realtime` today, selectable by the user from a relay-supplied
list, with `REALTIME_MODEL` as the deployment default.

**What the runs showed.** On an easy six-command script the flagship and
`gpt-realtime-mini` were indistinguishable: same six tool calls in the same
order, mini 77% cheaper. On a script with an indirect reference, a two-step
chain and a destructive action, they came apart:

| | flagship | mini | 2.1-mini |
|---|---|---|---|
| destructive protocol | correct | **inverted** | correct |
| task actually deleted | yes | **no** | yes |
| language | **drifted to Vietnamese** | English | English |
| cost | $0.0357 | $0.0089 | $0.0137 |

`gpt-realtime-mini` called `confirm_pending_action` *before*
`action_deleteTask`, so the confirmation hit an empty queue and the delete
only ever got staged. That is the one rule guarding the only destructive
operation in the manifest. `gpt-realtime-2.1-mini` got it right, stayed in
English, and still cost 2.6x less than the flagship — but narrated six
preambles aloud ("Okay, let me take care of that for you"), which is what
§9 exists to stop.

**Alias vs pinned is the part that matters operationally.** `gpt-realtime` is
a moving pointer; OpenAI can repoint it and take behaviour and price with it.
The Vietnamese drift is exactly the class of surprise that arrives that way.

**Revisit if:** we re-run the hard script a few times per model and 2.1-mini
holds up. On one run each it looks like the right default; one run is a signal,
not a benchmark.

---

## 7. Language: pinned in two places, and absent means auto

**Chosen:** a user setting. When set it goes to
`audio.input.transcription.language` *and* adds a rule to the instructions
fixing the reply language.

**Why both.** The transcription hint tells the recogniser what to expect. It
does nothing about what the model answers in — and the failure we actually saw
was in the replies, with the flagship answering four of six English turns in
Vietnamese. Verified after the change: a Spanish script came back entirely in
Spanish, with correct tool calls and no English leakage.

**Two API details that cost time.** `language` must be **absent** for
auto-detect: sending `null` is a 400 listing every valid code, so the obvious
spelling breaks the default path for everyone who never opens settings. And
what you send comes back normalised as `languages: ["es"]`, plural, so
inspecting the echoed `language` field tells you nothing about whether it took.

**What it costs:** transcription quality drops noticeably on non-English audio.
On the Spanish run "comprar leche" arrived as "Corbleche" and one turn came
through in Devanagari, which the model then read as a delete request. The audio
was synthetic and unaccented, so that is a reason to test with real speech
rather than a verdict.

---

## 8. Input transcription is a UI feature, not a dependency

**Chosen:** on, with `gpt-live-transcribe`.

**Why it is optional.** `gpt-realtime` is natively speech-in; it needs no text
transcript to pick a tool. The transcription exists solely to show the user
their own words in the panel. Nothing functional reads it, and turning it off
is one line.

**What it costs:** $0.017/min of *transcribed speech*, which measured at 27% of
a session — the second largest line. Billing is per committed turn, not
wall-clock: the completed event carries its own
`usage: { type: "duration", seconds: 3 }`, and ten minutes connected with a
live microphone and no speech produced one event and no charge. That last fact
was checked against the dashboard, not inferred.

**Revisit if:** cost matters more than showing the user their own words. It is
the cheapest 27% available and nothing breaks without it.

---

## 9. Replies are text by default, audio only when asked

**Chosen:** every follow-up we request carries an explicit
`output_modalities`, chosen per turn from the user's own words:
text for commands, audio for questions.

**Why the model cannot be asked to do this.** Told plainly to stay silent on
successful commands, it spoke on 6 of 6 turns anyway, and the silence rule cost
**30% more** than plain terse instructions — a rule about when speech is
justified reads as an invitation to justify it. Modality is config, and config
is obeyed:

| | spoken | audio tokens | cost |
|---|---|---|---|
| audio follow-ups | 6 | 201 | $0.0437 |
| text follow-ups | 1 | 41 | $0.0294 |

The surviving spoken reply was the one turn that asked a question.

**Why the follow-up exists at all.** After `function_call_output` items are
added, nothing is generated until a response is requested. Drop that request
and queries cannot be answered and query→action chains cannot continue. It is
load-bearing; only its *medium* was ever a free choice, and we were making it
implicitly in favour of the expensive one.

**How the decision is made in time.** From the streaming transcription deltas,
not the completed event — which arrives 300 ms *after* the model has started
speaking. The deltas trail the speaker by about one word, so the classification
is free.

**Revisit if:** the question heuristic misses real phrasings. The better fallback
is not a smarter classifier but an inversion: always request text, then decide
whether to speak *the reply*, which is a far easier judgement and cannot be
wrong about what the model chose to say.

---

## 10. Turn detection is theirs; the response should be ours

**Chosen, for now:** no `turn_detection` in the mint, so `server_vad` with
`create_response: true` applies. Push-to-talk sets `turn_detection: null` and
uses the button as the boundary. There is no voice activity detection in the
browser at all.

**The cost of the default.** `create_response: true` generates a reply in the
same instant it decides speech ended, so the modality of the *first* response
of every turn is not ours:

```
speech_stopped + committed     T+0.00
response.created (automatic)   T+0.00
first output audio             T+0.30
transcription.completed        T+0.60
```

That is why §9 only reaches the follow-up. On 2.1-mini all six spoken lines
were narration preambles from that automatic response.

**The lever, verified but not built.** `turn_detection: { type: "server_vad",
create_response: false }` is accepted by the API. The detector still commits
the turn; it simply stops generating, so every response becomes ours to shape.
That would put the preambles in text too — the largest remaining line at 37%.

**Watch out:** `session.update` must carry `session.type`, or the API answers
with an async `error` on the data channel and silently ignores the patch.
Push-to-talk shipped broken that way for a while, muting the microphone while
server VAD kept deciding turns underneath.

---

## 11. Instructions are terse by measurement

**Chosen:** an explicit "act, don't narrate" rule, concrete examples of the
length wanted, and a hard ban on the trailing offer of help.

**Why not adjectives.** The previous version already said "keep spoken
responses short" and "briefly confirm in one short sentence", and was ignored:

> before: "All set, we're now back on the dashboard. Anything else you'd like to do here?"
> after: "Done."

Audio output 816 → 318 tokens, session cost $0.0944 → $0.0448, and one extra
tool call because it retried the search instead of describing the option to.

**What it does not fix:** the agent still narrates *preambles* on some models,
because those come from the automatic response (§10), not from anything the
prompt controls.

---

## 12. Model and language are validated at the relay

**Chosen:** `GET /voice/options` serves the allowed lists; `POST /voice/session`
rejects anything else with a 400 rather than substituting a default.

**Why:** `model` decides what a minute of conversation costs, and a browser is
the wrong place to make that call — a tampered client should not be able to
bill the account for the flagship. Silent fallback is worse than an error: it
is how you end up running a model you did not choose.

---

## 13. Prompt caching is session-scoped, and cannot be widened

Measured: two sessions four seconds apart with a byte-identical prompt both
paid the full ~700-token prefix on their first response (`cached: 0`), then
cached from the second response on (`cached: 704`). `prompt_cache_key`, which
exists for exactly this, is rejected by the realtime endpoint:

```
400 "Unknown parameter: 'prompt_cache_key'."
400 "Unknown parameter: 'session.prompt_cache_key'."
```

**What follows:** many short sessions cost more than one long one, so a session
should be held across panel open and close rather than torn down per
interaction. That is a cost argument for warming on top of the latency one.
Keep `buildInstructions` and `buildTools` byte-stable within a session —
reordering tools mid-session would invalidate the cached prefix and multiply
the text cost tenfold.

**Not worth chasing:** the prefix is only ~6% of a session. Audio is the
expensive part, and §8, §9 and §10 are where the money is.


---

## 14. Warming: connect on hover, take the microphone on the click

**Chosen:** `warmup="hover"`. An ephemeral key is minted when the widget
mounts and kept fresh; the WebRTC connection is established when the pointer
reaches the pill; the microphone is acquired only when the user presses Talk.

**Why there is anything to warm.** Six things happen between the click and the
first word, and only one of them needs the user. Measured medians:

| step | |
|---|---|
| mint, via the relay | ~430 ms |
| SDP exchange, ICE, DTLS, data channel open | ~1,280 ms |
| `getUserMedia` | the only part that needs the user |
| **click to ready** | **1,640 ms** (3,382 on the first connect of a page) |

**What each trigger costs, measured on the same build:**

| trigger | felt at the Talk click | connects for |
|---|---|---|
| `off` — everything on the click | 1,640 ms | users who talk |
| `open` — mint + connect on panel open | 3 ms | users who open the panel |
| `eager` — mint on mount, connect on panel open | 5 ms | users who open the panel |
| `hover` — mint on mount, connect on pointer arrival | 3 ms | anyone whose cursor crosses the corner |

`open` and `eager` are indistinguishable at the click, because both have
finished by then. They differ only at panel-open: 1,713 ms against 1,283 ms,
so pre-minting is worth **430 ms** and only to someone who opens the panel and
clicks Talk inside 1.3 seconds. Hover moves the *expensive* part earlier
instead — the connect starts on pointer travel, which precedes the click that
opens the panel — so the panel is more likely to be ready the moment it opens.

**The 3 ms is a fake device.** On real hardware with permission already
granted, expect low hundreds; a first-time permission prompt is human time and
no strategy touches that.

**Why the microphone is never taken early.** For a user who has already granted
permission you could acquire it silently at hover. It lights the OS recording
indicator, and a widget that turns on someone's microphone because their cursor
passed nearby is how a product gets distrusted.

### What warming actually costs

Nothing in tokens, measured rather than assumed. A warm connection held 45
seconds with no microphone attached received exactly one event:

```json
{ "session.created": 1 }
```

The audio transceiver is negotiated `sendrecv` with **no track in it**, so
there is no media source to encode -- not silence, nothing. With
`create_response: false` (§10) the server generates nothing unless asked. And
an idle session bills zero: ten minutes connected with a *live* microphone and
pure silence moved the dashboard by $0.00, confirmed against the account 33
minutes later. A warm connection is strictly less than that.

Five connect-and-close cycles back to back all succeeded (1904, 1585, 1565,
1571, 1565 ms), with no throttling and no degradation. The `client_secrets`
endpoint returns no rate-limit headers at all, so account limits presumably
apply but are not advertised.

**What it does cost:** a request to your relay per page view for the mint,
another per hover for the connect, and an idle WebRTC connection doing
keepalives. That is infrastructure, not OpenAI's bill.

### Two facts that shaped this

**The ephemeral key lives ten minutes, not one.** Measured: `expires_at` came
back 601 seconds out. The one-minute figure in circulation is wrong, and it is
what makes pre-minting viable at all -- otherwise a key would have to be
redeemed almost immediately and "warm" could only mean "already connected".

**A refresh timer cannot be trusted.** A backgrounded tab has `setInterval`
throttled to roughly once a minute and may be suspended outright, so a key can
go stale while the timer sleeps. `ensureMinted` therefore checks freshness at
the point of use with a 60-second margin; the timer is an optimisation, not the
guarantee. Without that check, warming would make the click *slower* than not
warming: dead key, error, re-mint, connect.

### What made it safe

The transport/listening split (§ the `transport` / `micAttached` separation).
A warm session has `micAttached: false`, so `isListening()` is false and the
rim stays dark on a session the user never started. That was the prerequisite,
and it is asserted directly: `warm()` never calls `attachMic`.

`replaceTrack` rather than `addTrack` is the other half. The transceiver is
negotiated at connect time with no track, so attaching a microphone later needs
no renegotiation -- `addTrack` after the fact would require a second
offer/answer, which it is not clear this endpoint accepts.

### Revisit if

- **Page-view minting shows up as load.** `hover` mints on mount, so every page
  view costs a relay round trip whether or not anyone approaches the widget.
  Minting on hover instead, alongside the connect, removes that entirely and
  costs about 430 ms of the hover window -- still very likely finished before
  the click. One line, and the better default if the widget ships somewhere
  busy.
- **Touch matters more than desktop.** There is no `pointerenter` on a
  touchscreen, so hover degrades to the panel-open trigger there. If most usage
  is touch, `eager` is the honest choice, since it is what touch gets anyway.
- **Sessions are held rather than churned.** Prompt caching is session-scoped
  (§13), so warm-use-close-warm pays the ~1,500-token prefix every time. One
  session held for the visit is cheaper than several short ones, which argues
  for an idle teardown measured in minutes rather than per interaction.

---

## 15. A query result expires at the end of its turn

**Chosen:** a prompt rule saying so outright, placed *above* the batching rule
and naming the challenge phrasings ("are you sure?", "double check") as
triggers to re-query rather than to reassure.

**The failure.** From a real session, timings from the log:

```
 44.3s  query_settings          -> { name: "Steve Branson",     email: "stevebranson@example.com" }
172.7s  "what is my email?"     -> answered from the 44s snapshot, already wrong
202.7s  "and the name?"         -> "Your currently set name is Steve Branson."      no query
208.4s  "You sure?"             -> "Yes, the name in your settings is Steve Branson." no query
213.4s  "Double check"          -> query_settings -> { name: "Steve Branson Jr" }
```

The name had been edited in the app in between. It answered three times from a
170-second-old read, and only looked when told to in so many words.

**Why the prompt was at fault, not just the model.** Nothing in the
instructions said state could change between turns, and the batching rule --
*"call the query ONCE with no filter and pick from the result, never one query
per thing"* -- argues for exactly the wrong behaviour when read across turns
instead of within one. It exists to stop eleven lookups for twelve months; it
was never meant to license reusing a two-minute-old answer. The staleness rule
now precedes it, and a test asserts that ordering.

**The part that matters most** is the challenge case. Re-asserting a wrong
value when questioned is worse than the original error: it spends the user's
trust to defend it, and teaches them that asking again tells them nothing.

**Verified by replay.** The same five turns, with the settings edited
underneath the session between turn one and turn two:

```
 6.3s  "what is my currently set email?"  query_settings -> "...stevebransonjr@example.com."
11.3s  "and the name?"                    query_settings -> "Your currently set name is Steve Branson Jr."
16.3s  "You sure?"                        query_settings -> "Yes, the name is Steve Branson Jr."
21.1s  "Double check"                     query_settings -> "It's still Steve Branson Jr."
```

Four questions, four queries, four correct answers. The cost of the fix is one
extra query per value stated, which is a tool call against the host app's own
code -- no tokens beyond the result, and no round trip to OpenAI.

**Also found here:** the language rule carried a hardcoded number and had been
shipping as a second "7" since the sixth rule was added. Rule numbering is now
asserted to run 1..n once each, with and without a language pinned.

---

## 16. Hanging up: the microphone goes now, the connection goes later

**Chosen:** an `end_session` tool the model calls when the user dismisses it.
Acting on it releases the microphone immediately and closes the connection
five minutes later, or never if the user comes back.

**Why two speeds.** They answer different questions. Releasing the microphone
is what the user actually asked for, and it is the half they can verify
themselves: the OS recording indicator goes out. Closing the connection is a
cost decision, and it points the other way. Prompt caching is session-scoped
(§13), so a session closed and reopened pays the whole instruction prefix
again. Someone who says "actually, one more thing" ten seconds after saying
thank you should not pay for having been polite.

**The bug this is shaped around.** `end_session` arrives *inside* a response,
and the goodbye it asks for is a *second* response, generated after the tool
result goes back. Tearing down where the call lands cuts off the farewell the
same rule just requested. Worse, `response.done` fires while audio is still
coming out of the speaker, so waiting for the response is not enough either.

Measured, same two turns, once with a written goodbye and once spoken:

| goodbye | reply logged | hang-up fired |
|---|---|---|
| text | 8.5s | 8.5s |
| audio | 9.0s | 10.3s |

The 1.3-second gap is "Take care, goodbye!" being spoken. Both paths are
needed: a spoken goodbye ends at `output_audio_buffer.stopped`, a written one
at `response.done` with no audio ever starting, and wiring only the first
loses every text hang-up silently.

A 15-second timeout forces the release regardless. If a response or an audio
event never completes, the alternative is a live microphone after the user said
they were done, which is the one outcome this must not produce.

**The prompt rule is narrow on purpose.** The terseness rules (§11) already
push toward wrapping up; "act, don't narrate" plus "never offer further help"
reads a lot like permission to hang up the moment a task succeeds. So the rule
says outright that completing a task is not a dismissal and neither is an
error. Tested against a five-turn script containing a completed navigation, a
successful query, a failed delete, an explicit "no, cancel that" and a final
question: zero hang-ups. Two farewell phrasings, "thanks, that's all for now"
and "ok we're done here, bye": one each.

**A spoken dismissal earns a spoken goodbye.** The medium mirrors the turn that
ended the conversation, rather than going through the transcript heuristic
(§9), which reads "thanks, that's all" as command-shaped and answers in text.
Someone who dismissed the agent out loud has probably already looked away, and
a farewell they never see is not a farewell.

**A staged destructive action does not survive.** Saying "that's all" with a
delete awaiting confirmation cancels it. Otherwise it waits, and some later
"yes" executes something nobody is thinking about any more.

---

## 17. Cost measurement lives in the relay, not in the package

**Chosen:** the relay totals every session it logs and appends a `summary`
line, and a usage report compares sessions and models. Nothing reaches
the widget's public API.

**Why not the hook.** This is a bench instrument for choosing a provider, not
a feature a host app needs. The relay already receives every event a session
produces, so it is the one place that can total a session without the client
knowing it is being measured, and without adding a field somebody later
depends on.

**Two things make this harder than summing a column.**

Cached input is *inside* `input_tokens`, not additional to it. Adding both
charges the prompt prefix twice, and the prefix is the largest thing in these
sessions: one measured session carried 4,160 cached tokens inside 6,431 input
tokens. The tally subtracts it out at fold time, using
`cached_tokens_details`, so every field afterwards means what it says.

Audio and text price differently in both directions, by roughly an order of
magnitude. A single "input tokens" total cannot answer the only question worth
asking here, which is what the audio costs.

**Unpriced is not free.** A model with no entry returns `priced: false` rather
than a total of zero, because a silent zero makes an unknown provider look
like the cheapest thing in the comparison.

**Rates live in a `prices.yaml`, not in source.** They change on someone
else's schedule, and a table you have to edit a module to update is one that
goes stale while still being trusted. YAML rather than JSON for one reason:
every rate wants a date and a source URL beside it, and JSON cannot hold that.
The file carries a `checked:` date and the report prints it under every table.

The loader validates rather than trusting. An unknown rate name or a
non-numeric value is refused with the model and field named, because a
misspelled `inputAudo` would price all audio at nothing and look like a
bargain -- the silent-zero failure again, arriving through the config file
instead of through a missing model. A broken file fails soft inside the relay,
where a session still gets its token counts, and loudly under `--prices`,
where that table was asked for by name.

**Providers do not agree on the unit.** An entry may price per million tokens,
per minute of transcription, per minute of connected time, or any combination,
so a provider that bills by the clock can be compared against one that bills by
the token. `--prices mine.json` replaces the whole table without touching the
source.

**Calibration.** Totalled across the six real sessions on disk, the busiest one
comes out near the figure the OpenAI dashboard reported for it, which is the
only external check available. The rates in `PRICES` are list prices, they go
stale, and the report says so every time it runs.

---

## 18. The rim reports the microphone, and separately reports the agent

**Chosen:** `working` is shown whenever the agent has the floor, with no regard
to the microphone. `ready` and `listening` require the microphone to be
genuinely OPEN, not merely attached.

**What was wrong.** `rimState` returned null whenever no microphone was
attached, before it ever looked at whether the agent was busy. So someone who
typed a command got no feedback at all: the agent navigated, called tools and
answered over several seconds, and the screen said nothing the whole time. The
two questions had been conflated. "Can I hear you" is about the microphone;
"am I doing something" is about the agent, and a typed turn puts the agent to
work exactly as a spoken one does.

**And it was wrong in the other direction too.** A muted microphone showed
`ready`. Push-to-talk rests muted, so its rim claimed to be listening whenever
the button was not held; push-to-not-talk showed `ready` while the button was
deliberately holding the microphone shut. Saying "I can hear you" over a shut
microphone is the one claim this rim must never make, and it was making it in
the mode where users are most deliberate about being heard.

Both now go dark. A muted-but-connected state may earn its own palette later;
it is simply dark for now.

| | before | after |
|---|---|---|
| agent working on a typed turn | nothing | working |
| push-to-talk at rest | ready | nothing |
| push-to-not-talk while muted | ready | nothing |
| push-to-talk while held | listening | listening |

The gate reuses `isListening()` rather than re-deriving the mode rules, so the
widget's one privacy predicate and its most visible affordance cannot drift
apart.

---

## 19. Three tiers, and the top one exists because the middle failed

**Chosen:** `<Interpreter/>` assembles the bubble and the rim;
`<InterpreterBubble/>` and `<ListeningGlow/>` remain separately usable;
`useInterpreter()` exposes the session with no UI.

**Why the top tier was added.** The first real integration rendered only the
bubble and got no rim. Nothing failed. Nothing warned. The app looked
finished, and the missing half of the feedback was invisible until someone
compared it against a reference integration. Assembling the pieces meant
importing three exports, calling `useInterpreter()`, deriving the rim's state
by hand and rendering two components in the right places -- about seven lines
that every host would write identically, and that a host can silently skip.

Flexibility was never the problem; discoverability was. The lower tiers are
unchanged and lose nothing.

**Why not fold the rim into the bubble instead.** They occupy different
overlay layers and a host may legitimately want one without the other -- a rim
with custom chrome, or a bubble in an app that finds a full-viewport glow too
loud. Merging them would remove a real choice; adding a component that makes
the choice for you removes none.

---

## 20. The agent is busy for the whole turn, not just while generating

**Chosen:** `agentBusy` covers the model generating, a tool executing, and the
follow-up being requested. The turn is held open from the moment a response
asks for a tool until the reply after it has been asked for.

**What was wrong.** `response.done` cleared the busy flag, and `response.done`
is exactly when the model finishes ASKING for a tool. So the rim went back to
"ready to listen" for the entire time the tool ran, and stayed there until the
server acknowledged the follow-up. Requesting that follow-up set the flag
without telling the rim at all, so the gap included a network round trip.

Observed live: a user drove cal.diy for four minutes and reported that the
working colour never appeared once, that the rim went "straight to ready to
listen" on every tool call. They then spoke, because the interface told them
it was their turn. Seven of the ten dead responses in that session were the
follow-up after a tool call.

That is the part worth keeping in mind. The rim was not merely uninformative
during the agent's turn, it was actively inviting interruption.

**Two blinks, both closed.** Between `response.done` and the first tool
starting, and between the last tool finishing and the follow-up being
requested, nothing was active and the rim called it idle. Both are one tick
wide, and one tick is enough for a 700ms crossfade to start animating. The
hold is taken in `response.done` when the response carries a function call,
and released in a `finally` after `requestResponse()` -- a throw on a closed
data channel would otherwise leave the rim lit forever with nothing behind it.

Measured across a deliberately slow tool, busy now holds continuously:

```
2.5s  agentBusy true      (response requested)
3.1s  response done, out=11   (the model asked for a tool)
3.1s  dom_snapshot STARTED
5.6s  dom_snapshot FINISHED
6.4s  response done, out=55   (the reply)
7.9s  agentBusy false
```

**Also added, because none of this was answerable from the logs.** A response
now records its `status` and `status_details`: ten responses in that session
reported zero input AND zero output tokens, which no real generation can do,
but cancelled, failed and incomplete were indistinguishable from a deliberate
silence. Tool calls record how long they took, since recording only on
completion made a two-second tool look instant. And activity transitions are
recorded when they change, so a log can say what the user was being SHOWN
while a tool ran, which is the one thing needed to explain "nothing was
happening" afterwards.

---

## 21. The manifest belongs to the app, and travels with the session request

**Chosen:** the app imports its own `.voice/manifest.json` and passes it to
`VoiceProvider`, which sends it with each mint. The relay builds the tool list
from what arrives and holds no manifest of its own. `MANIFEST_PATH` and
`GET /voice/manifest` are gone.

**The failure that forced it.** A relay was restarted with only `PORT` in its
environment. `MANIFEST_PATH` fell back to a default pointing at a sample app,
so the relay serving a calendar app built its tools from a task manager's
manifest. Asked to open bookings, the agent explained politely that the app
had no bookings section and offered to help with tasks instead. It was not
confused. It was told it was driving a task manager, and it described that
accurately.

Nothing errored, at any layer, because a default produces a wrong answer that
looks like a right one.

**What the old shape actually was.** The CLI wrote the manifest into the app's
repo. Someone copied it where the relay could read it. The relay served it
back over the network to the widget running inside the app that had produced
it, and the widget used that copy to resolve endpoints while the relay used
its own copy to build tools. Two copies of one file, agreeing by convention.
The round trip was the bug.

**What actually had to be server-side, on inspection.** Less than the code
claimed. The comment above the mint endpoint said the tool list lived there
"so a tampered client can't redefine its own tools or quietly drop a
requiresConfirmation flag". That is wrong twice over: the widget executes every
tool in the user's own browser against the app's own API with the user's own
cookies, so redefining tools grants nothing that calling the API directly would
not; and the relay never enforced confirmation anyway, it only wrote the word
"destructive" into the prompt, with the staging done entirely client-side.

What genuinely needs the server is the API key, and the decisions that spend
the relay owner's money. The manifest is neither.

The one real constraint is timing: instructions and tools attach at session
creation and cannot change afterwards, because prompt caching is
session-scoped. So the manifest must be known at mint. Sending it satisfies
that without anyone storing it.

**No size cap, deliberately.** On a relay you host, the tokens are your own. On
one we host, the gate belongs at the door -- authentication and metering --
rather than in the shape of the payload. The manifest is validated for shape
only, and refused outright when absent: a wrong-but-plausible default is worse
than an error.

**What this buys beyond fixing the bug.** The relay becomes stateless per app,
so one deployment serves any number of them and there is no per-app
configuration to get wrong. Verified by minting for two different apps against
one relay and getting two different tool lists. Self-hosting and
bring-your-own-key work without a control plane. And the manifest can no
longer drift from the code, because it ships from the same commit -- which a
pushed-to-a-server manifest can always do, the moment an app is rolled back.

Sessions now record the shape of the manifest they were built from, since the
relay no longer knows and a log otherwise could not say which app a session
was for. That is exactly what nothing recorded when this went wrong.

---

## 22. The analyser is a core plus detectors, and the widget speaks more than REST

**Chosen:** `core/` holds the contract, runner, merge, overlay and exclusion
engine; `frameworks/` and `schema/` hold detectors; `registry.js` is the one
file edited to add coverage. On the widget side, `transports.js` turns a
manifest operation into a request, with REST and tRPC as the two shapes.

**Why it had to stop being one file.** The original analyser was three
hardcoded readings of three hardcoded filenames. It worked for the app it was
written against and produced literally nothing for the first real app it met.
Growing it meant either one file that knew about every framework, or a plug
point. The plug point is a documented contract, validated at load: a name, a
`describe` that is shown when the detector finds nothing, a `role` deciding
whether it runs before or after the producers, an optional `applies`, and
optional `excludes`.

Three details each paid for themselves within a day of existing.

`role` exists because enrichers mutate what producers found and used to be
ordered by their position in an array. Reordering that array was enough to
make every schema reader silently do nothing -- no error, no missing output,
just actions that quietly had no body.

`applies` exists because "does not apply" and "found nothing" are different
answers. The Pages Router detector claimed four routes from a plain React
app's `src/pages/` components folder, a coincidence of naming that produced
results indistinguishable from real ones.

`excludes` belongs to the detector rather than a global list because a plain
React app must never be filtered by Next.js conventions, and because the rules
change as coverage grows: `/api/trpc` was infrastructure until the tRPC
detector could read the procedures behind it, at which point a blanket rule
was filtering all 172 of them away.

**What discovery turned out not to solve.** Reading cal.diy went from zero
operations to 177. That is 11,700 tokens of prompt prefix, paid on the first
response of every session, and 177 choices for the model on every turn. The
overlay takes an `include` list and the CLI warns above 40 tools with the cost;
22 chosen operations bring cal to 30 tools and ~3,900 tokens. Selecting is now
the harder half, and it belongs to whoever knows which twenty matter.

**Why transports had to be pluggable too.** tRPC is not REST. Procedures are
addressed by path, input is superjson-wrapped as `{ json: ... }`, and it
travels in a query string for a query and in the body for a mutation, with the
reply nested at `result.data.json`. A manifest entry declares `transport` and
the widget builds the request accordingly; an entry without one is REST, which
is what every manifest written before this relies on.

One seam moved as a result. `apiFetch` used to throw on any non-2xx, which
reported "Request failed: 401" and discarded the body. tRPC puts the reason in
that body, so which reply counts as a failure is now the transport's question.

Verified against a running cal.diy with real authentication: `availability.list`
returns a schedule, `me.get` returns the signed-in user.

---

## 23. The manifest is checked against the running app, not just derived from it

**Chosen:** `voice-cli probe <manifest> <baseUrl>` asks the app whether the
manifest is true, and writes what it learns into the overlay. Read-only by
default; `--writes` is an explicit flag because probing a write means
performing one.

**Why static analysis cannot be the end of it.** It reads structure, and
structure is not behaviour. It can see that a route file exists and that a
schema marks a field optional. It cannot see that the route was moved, that
the endpoint redirects, or that the server accepts a request without a field
the schema calls required. Only asking settles those.

**The first real run found exactly that.** A host app's `updateSettings`
declares `name`, `email` and `theme` all required, because that is what the
Zod schema says. The server accepts `{"theme":"dark"}` on its own, verified by
hand. So the manifest was telling the model it must supply all three to change
one -- which means "make it dark" makes the model invent a name and an email,
and an agent overwrites two fields nobody asked it to touch. A wrong
`required` flag is not a cosmetic error; it manufactures data.

**Probing also discovers what the manifest cannot express.** There is no way
to say what a query returns, so the model infers the shape from the tool name
and whatever arrives at runtime. One call answers it:

```
tasks    → a list; each item has id, title, done, dueDate, notes
settings → an object with name, email, theme
```

That reaches the model as a sentence in the tool description and costs about a
dozen tokens. Deliberately shallow: a full JSON Schema of a booking would cost
more than every other entry in the manifest combined.

**What it refuses to do.** A route with a parameter is skipped rather than
visited with an invented id, because a 404 from a made-up id says nothing
about the manifest. A 401 or a redirect is not a failure -- plenty of real
routes bounce to a login page, and following that would only prove the app has
authentication. A 500 during an omission probe records "nothing learned"
rather than a guess, since it might be the missing field or the app having a
bad day.

**Findings land in the overlay, never the generated file.** They are
corrections, they survive regeneration, and a human reads the diff. That
matters more here than elsewhere, because a probe writes into the prompt every
future session will carry.

**One practical note.** Probing every route against a development server
forces a compile of every route, which is a real memory spike on a large app.
Probe a production build, or pace the requests.

---

## 24. A flow is an action, not a new kind of thing

**Chosen:** an operation with `transport: "dom"` and a list of steps. The model
calls it like any other action; the widget performs the interactions.

**What was missing.** Some of what an app can do has no URL and no endpoint.
Creating an event type in cal.diy opens a dialog with four fields and a
Continue button, and the address bar never changes. Routes describe where you
can go; queries and actions describe what you can call. Nothing described what
you can DO once you are somewhere.

So the agent reached it the only way it could: snapshot the page, guess which
element was which, click around. That is how it typed a description into a URL
field.

**Why an action rather than a fourth section.** A flow takes named inputs,
changes something, is sometimes irreversible at a particular step, and is what
a person asks for. That is an action. The only difference is that it executes
as a sequence of interactions instead of one HTTP call, and `transport`
already existed to say how an operation executes.

The payoff is that nothing else changes. `buildTools` produces an ordinary
`action_createEventType` from the same `bodyFields`; the tool list gains no new
category; the model calls it with three named fields and never learns a dialog
is involved. The steps are not in the prompt at all -- they are execution
detail, and putting them there would invite the model to reason about clicking,
which is precisely what this removes.

**Steps target labels, not selectors.** A selector breaks on every redesign. A
label is what `dom_snapshot` already reports and what the person asking would
have said. An exact match wins; otherwise the shortest label containing the
word, so "Title" does not land in "Title of the recurring event".

**Two things a flow must handle that an HTTP call need not.** It has to wait:
clicking "New" opens a dialog, and the dialog is not there on the next line of
JavaScript, so without waiting every flow whose first step opens something
fails on its second. And stopping partway is a real state rather than a plain
failure -- a flow that filled two fields and could not find the third has left
a half-completed dialog on screen. It reports which step, what it was looking
for, what it already did, and that the model should look before starting over,
because starting over fills the first two fields twice.

**Verified against the dialog that caused all this.** Given
`{title, description, duration}` and no other knowledge, the flow clicks New,
waits for the dialog, and fills all three:

```
Title        "Voice Made This"
Description  "A quick video meeting."
Duration     "25"
```

---

## 25. Deferred: an agent pass, and tiering the manifest

Two ideas we decided are worth having and not worth building yet. Recorded
because the reasoning is the perishable part, not the idea.

**An agent that drives the app and writes down what it learned.** Contextual
descriptions in natural language, how multi-step flows actually work, and a
judgement about which operations are worth offering at all.

Deferred in favour of two cheaper signals that get most of the way. Apps
describe themselves: cal.diy's event-types page renders "Event types /
Configure different events for people to book on your calendar", written by
someone who knew what the page was for, and better than anything a model would
invent. Nav link text, `<title>` and meta descriptions are the same. And which
operations matter can be counted rather than judged -- 52 of cal's 177
discovered operations are referenced nowhere in the client or shared source at
all.

**Revisit if** harvesting comes back thin, which it will on an app whose
headings are decorative or absent. Harvesting reads what a careful team wrote;
a model is what you need when nobody wrote anything. So this belongs as an
opt-in extra pass rather than a replacement, and the output belongs in the
overlay where a human reviews it before it becomes prompt content.

**Tiers, with a tool to look deeper.** The manifest carries everything, richly
described. Only tier one reaches the session prompt; the model can look up the
rest through a tool when it has reason to.

Deferred because we have not yet got a manifest large enough to need it. Cal
went from 208 operations to 30 with an include list, and 30 tools is about
3,900 tokens of prefix -- billed once per session and cached after the first
response, so roughly a cent and a half. The cost that actually hurt was 208
tools, most of which were cron jobs and OAuth callbacks that belong in no tier.

**One constraint to design around when we do build it.** The tool list is
fixed at session creation, and a `session.update` that changes it rewrites the
cached prefix, so the next response pays the full amount again:

```
response 1   1,947 input,     0 cached
response 2   1,986 input, 1,984 cached
```

So expansion has to be information rather than tools: a fixed, small tool list
plus a lookup that returns descriptions, with a generic executor for what is
not in the list. The widget already holds the whole manifest, so both run
client-side with no round trip.

**And tier one needs a table of contents, not just tools.** A capability the
model cannot see is one it will never think to look for; it will say "I can't
do that" rather than search. A sentence naming the territory -- "this app also
handles teams, webhooks and integrations" -- is about thirty tokens and is what
makes the rest reachable at all.

**Revisit if** a real app has hundreds of genuinely user-facing operations
after honest pruning.


---

## 26. Harvest the app's own words, and count who calls what

**Chosen:** the probe collects each page's heading, the line beneath it and
its title, and turns them into route descriptions. The generator counts how
often the app's own code calls each operation.

**Why not a model, at least not first.** Apps describe themselves. cal.diy's
event-types page renders "Event types / Configure different events for people
to book on your calendar" -- written by someone who knew what the page was for,
and better than anything a model would invent from a filename. Harvesting it
costs one extra read of a response the probe already fetched.

**Deciding what counts as a description takes all the pages at once.** A title
is usually "Availability | Cal.diy", and no single page can tell which half is
the product. Picking the longer half chose "Cal.diy" over "Error" and
described every page as the product name. Counting which segment repeats
across pages cannot make that mistake.

Two rejections matter as much as the harvest. A description equal to the last
path segment is dropped -- "/availability" described as "Availability" costs
tokens and says nothing the model could not read off the route. And a title
that is only the product name is dropped for the same reason. On cal that took
46 candidates down to 20 real ones.

**What it cannot do.** A client-rendered page serves a shell, so its heading
exists only after hydration and the served HTML has nothing to harvest. Twenty
of cal's 81 routes described themselves; the rest are behind authentication
and rendered on the client. Reading a rendered DOM would need a browser, which
is a heavy dependency for a published CLI, so that is the natural home for the
optional agent pass in §25 rather than for this.

**Counting call sites is the pruning signal that patterns miss.** 52 of cal's
177 discovered operations are referenced nowhere in the client or shared
source: `/api/tasks/cron` is called by a scheduler, `/api/stripe/webhook` by
Stripe, `/api/me` by third-party consumers of the public API, `/api/version`
by an uptime check. Path rules already caught cron and webhooks. Nothing in a
pattern catches `/api/version` or `/api/me`.

Recorded as a number on each operation and reported, never acted on. Zero is a
strong signal and still only a signal: an endpoint added last week for a page
shipping next week counts zero and is perfectly real. An operation with no
searchable term records `null` rather than `0`, because "nothing calls this"
is a claim and "no question was asked" is not, and writing the first when you
mean the second is how something gets pruned for the wrong reason.


---

## 27. A page's own description is in its source, not only on the screen

**Chosen:** a detector reads what each page declares about itself -- a
metadata export, a heading, a title prop, or a translated key resolved against
the app's locale files. Probing keeps its harvest as a second source.

**Why this beats probing at the same job.** Probing can only recover a
description from a page that renders on the server. cal.diy serves a shell for
61 of its 81 routes, so probing learned nothing about any of them. Reading the
source described 53, and the text is better:

```
/event-types   Event types. Configure different events for people to book on your calendar.
/bookings/:status   Bookings. See upcoming and past events booked through your event type links.
/availability  Availability. Configure times when you are available for bookings.
```

That is the exact sentence the rendered page shows, recovered without running
anything.

**Generic by looking for shapes rather than a framework's API.** A `metadata`
export is Next.js's answer; `<h1>` and a `title` prop are nobody's in
particular; a positional `generateMetadata(t => t("a"), t => t("b"))` is a
convention every wrapper of that shape follows. All three reduce to "string
literals in title-ish positions", which is a question you can ask of a
component tree without knowing what built it.

**Internationalisation is the hop that makes it work at all.** Source holds
`t("event_types_page_title")`; the sentence lives in a locale file, in cal's
case four directories away in a sibling package. Without resolving it, every
page in an internationalised app describes itself as a key -- which is worse
than describing itself as nothing, because a key looks like information. A key
with no English is skipped for exactly that reason.

**Cost:** 53 descriptions add 955 tokens to cal's routes, taking them from
1,117 to 2,072. Worth it, and worth watching: seven of them run past 90
characters, and if that grew it would be the first thing to trim.

---

## 28. The probe signs in, because an anonymous probe measures the login page

**Chosen:** `--login <spec.json>` runs a described sign-in sequence and keeps
the cookies. The spec is a file, not arguments, because credentials in a
command end up in shell history.

**What it changes.** Without a session most routes answer with a redirect to a
login page, which the probe correctly records as "exists" and nothing more.
Every question worth asking is answered by the logged-in version: whether the
page is real, what it says about itself, what a query returns, which fields the
server requires.

Signed in against cal, the probe found `/auth/verify-email-change` returning
404 -- a route the manifest claims and the app does not have. Anonymously that
route redirected to login and counted as fine.

**A cookie is the proof of sign-in, not a status code.** A login endpoint
answering 200 with an error in its body is the ordinary way to fail. A session
IS a cookie: if none arrived that was not there before, nothing happened. And
an expired cookie is treated as a deletion, since sending a dead session back
is worse than sending none -- the app answers as though someone is signed in
and then fails halfway.

**One caution.** A probe signed in as a real user is one careless `--writes`
away from modifying that user's data, which is an argument for pointing it at
a seeded, disposable instance rather than anything shared.


---

## 29. A colour fade needs a different curve and a different space than a movement

**Chosen:** 1200ms, linear easing, mixed in OKLab.

**The report was that state changes felt abrupt**, and the interpolation was
working the whole time. Sampling the rendered gradient during a change showed
it moving through real intermediate colours over ~660ms. Two separate things
made that read as a snap.

**easeInOut is right for movement and wrong for colour.** You track a moving
object, so acceleration reads as weight. A colour has no trajectory to follow,
so all you see is the middle burst. Measured across four windows of a 700ms
fade, easeInOut carried 11%, 25%, 39% and 26% of the change -- a pause, a
lunge, a pause.

**And linear light is not perceptually uniform**, which is the subtler half.
Switching to a linear ramp did not fix it, because an even ramp through
linear light still *looks* like it accelerates: on orchid to lagoon the first
eighth carried 10% of the visible change and the last carried 17%.

Measuring that needed the right ruler. Euclidean RGB distance said sRGB was the
most even of the three, which is exactly the error OKLab exists to correct.
Measured in OKLab, where equal distances are equally visible:

| space | change per eighth | spread |
|---|---|---|
| sRGB | 19 18 17 14 12 9 7 4 | 15 |
| linear light | 10 10 11 12 12 14 15 17 | 7 |
| OKLab | 12 13 13 13 12 12 12 13 | **1** |

**OKLab also wins the argument linear light was brought in to settle.** §on the
palettes chose linear light because sRGB dips through a muddy middle, worst on
blue to green, which is the trip from listening to working. At that midpoint
OKLab holds more chroma than either: 0.109 against sRGB's 0.100. So it is not a
trade at all -- the space that fades evenly is also the one that stays
saturated.

**Duration is the smaller half but still real.** 700ms is brisk for a
full-viewport colour change with nothing to track. 1200ms, spread evenly,
reads as movement rather than a switch.

## 30. A shadow root is not a document, and @property notices

**Chosen:** strip the `@supports` gate off Tailwind's own fallback block, in
the package's build, so the `--tw-*` initial values always apply.

**The report was that the widget rendered unstyled.** It did not. The
stylesheet was in the bundle, reached the shadow root, and every rule matched:
`--tw-shadow` held `0 8px 24px #00000029` and the panel's computed `box-shadow`
was `none`.

Tailwind v4 writes shadows as a five-variable chain and `shadow-*` sets only
the last one. The other four come from `@property` registrations. **`@property`
is registered per document**, and a stylesheet inside a shadow root is ignored
for it -- the rules parse and nothing registers. So four of the five vars stay
guaranteed-invalid, the declaration is invalid at computed-value time, and the
whole shadow is dropped with the correct value sitting right there.

What it took out, measured in the shipped widget:

| utility | in the document | in the shadow root |
|---|---|---|
| `shadow-*` | 0 8px 24px | none |
| `border` | 1px solid | 0px, style none |
| `ring-*`, `scale-*`, `blur-*` | applied | dropped |

A white card with no shadow and no border, on a white page, is invisible --
which reads as "the stylesheet never loaded" and sends you to check the bundle,
where everything is fine.

Tailwind already emits the fix, a `@layer properties` block assigning every
initial value on `*`. It gates it behind an `@supports` matching only engines
without `@property`, because on Chromium the registration is assumed to work.
In a shadow root it does not, on any engine. Removing the gate is 30 lines of
build plugin and the declarations land at specificity 0 in the first layer, so
a host's own utilities still outrank them.

## 31. A mask layer that does nothing still costs a frame

**Chosen:** emit only the corner layers the current `cornerRadius` sign uses,
and clip the rim to the band it occupies.

**The rim stuttered.** Not the colour: sampled through a state change, the
crossfade moves at a flat 0.83 OKLab units per second for its whole 1200ms,
which is what §29 built. The stutter was the frame rate.

The rim's mask is ten full-viewport layers: four corner holes, four corner
blooms, two edges. Holes and blooms are the two signs of one control, so **one
set is always at its no-op** -- and at the default `cornerRadius: 0`, both are.
A no-op layer is free to write and expensive to run: every frame the rim moves,
the browser recomposites the whole stack.

Measured at 1440x900, rim on, nothing else animating:

| configuration | fps | median frame | p95 |
|---|---|---|---|
| 10 layers, as it shipped | 21 | 49ms | 64ms |
| 6 layers (one side) | 28 | 35ms | -- |
| 2 layers (edges only) | 40 | 25ms | -- |
| 2 layers + ring clip | **59** | 17ms | 21ms |

Roughly linear in the layer count. Neither half is expensive alone -- unmasked,
the same animation holds a flat 60; masked but frozen, also 60. It is the
combination, and eight of the ten layers were paying into it for nothing.

**Verified by pixel comparison, not by argument.** Both stacks rendered over a
held-still sweep and diffed: the largest difference is 1 of 256 on 0.14% of
bytes, which is compositor rounding. Two mistakes were caught that way and
neither would have shown up in a screenshot glance:

- `clip-path: polygon()` is ONE closed path with no way to declare a subpath.
  Listing an outer and an inner rectangle as eight points with `evenodd` builds
  a self-intersecting octagon, and it clipped away most of the left and right
  bands. The hole has to be cut the way SVG does it: outer clockwise, back to
  the start, inner counter-clockwise, nonzero rule.
- A clip edge is antialiased. Drawn at exactly `0%`, it halved the coverage of
  the brightest column of the rim and left a dark 1px outline around the whole
  viewport. The outer rectangle now sits 2px outside the element.

**The measurement rig had to be fixed first, twice.** framer rewrites the
`background` SHORTHAND every frame, which clears an `!important`
`background-image` -- so "freezing" the sweep in place did nothing and the two
screenshots differed by the rotation. And session logs cannot answer a timing
question: the widget batches events for 2s with no timestamp and the relay
stamps them on receipt, so a whole turn arrives sharing one millisecond. That
made a real turn look like four rim states inside 1ms. It is not; the log
simply cannot say. Worth fixing separately.

## 32. The route and the pace are two different problems

**Chosen:** interpolate in OKLCh, walking around the hue wheel, and
reparameterise that route by arc length so it still advances evenly.

**§29 fixed the pace and left the route alone.** The report this time named two
transitions and not the third: violet to lime and lime to prism felt sharp,
violet to prism did not. That pattern is the whole diagnosis.

A straight line between two OKLab a/b coordinates is a **chord**, and a chord
between near-opposite hues passes close to the neutral axis. Chroma at the
halfway point, as a fraction of the endpoints':

| transition | hue gap | OKLab | OKLCh |
|---|---|---|---|
| listening → working (violet → lime) | 106-173° | **13-19%** | 89-115% |
| working → ready (lime → prism) | 45-124° | 49-65% | 72-151% |
| listening → ready (violet → prism) | 18-84° | 83-105% | 106-116% |

The two that collapse are exactly the two that were reported. The rim sits at
53% alpha over the host page, so near-grey is very close to invisible: it
washes out mid-fade and reappears as the new colour, which reads as a switch
rather than a move. Screenshots at the halfway point show it plainly -- a dull
olive-grey band under OKLab, a clear blue one under OKLch.

**But swapping the route broke the pace, which is why this is one entry and not
two.** OKLCh's own parameter does not advance evenly in OKLab: the hue term
contributes chroma times the turn, and pulling chroma back at the sRGB boundary
stretches and squeezes what is left. Raw OKLCh carried 16.5% of the change in
its first eighth and 10.2% in its sixth -- a 1.6x spread, about what linear
light gave, and §29 records why that reads as accelerating.

So the route is sampled once per colour pair, the OKLab distance between
samples is measured, and that table converts "fraction of the fade elapsed"
into "fraction of the way along the route". Both properties, measured on the
shipped palettes:

| space | spread across eighths | chroma held at halfway (worst stop) |
|---|---|---|
| OKLab | 1.06x | 13% |
| OKLCh, raw | 1.63x | 78% |
| OKLCh, paced | **1.10x** | **89%** |

**Two instruments had to be thrown away to get there.** Sampling one 6x40 patch
of the rim said the fade was front-loaded 2.1x, which was the sweep rotating
through that patch, not the fade. Averaging the whole top edge said something
different again -- the mean colour of a rainbow is near-grey and moves
erratically while every stop moves smoothly. Only the per-stop reading, taken
off the live gradient each frame, measures the thing the eye is tracking.

## 33. A click is not the same event as a message

**Chosen:** the fade's destination is a ref set beside its origin and its
progress, never the `state` prop read during render.

**The rim flashed the destination palette for one frame before every fade.**
Measured on a replayed turn: at the instant the state changed, the gradient
painted `rgb(59,130,246)` and `rgb(249,115,22)` -- prism's blue and orange, at
full strength, in the middle of a violet rim -- and on the next frame snapped
back to violet and faded properly. 68x the fade's own per-frame movement.

`background` recomputes on framer's frame loop and needs three things to
agree: where the fade started, where it is going, and how far along it is.
Origin and progress were set in the effect; the destination was read from a
value assigned during **render**. Between those two moments the trio
disagrees, and `mix` is still 1 from the fade that just finished -- so
`mix(oldOrigin, newDestination, 1)` is the destination, exactly.

**Why every measurement said the fade was even.** React flushes passive effects
synchronously for discrete input, so a click closes the window before the
browser can paint. Every instrument built for §29 and §32 drove the change with
a click, and none of them ever saw it. A `setTimeout` does not get that
treatment. Neither does a data channel message, which is what changes the rim's
state in a real session -- so the bug was in every real turn and in none of the
tests. The user could see it and the tooling could not, for four rounds.

What broke the deadlock was a control the user could work themselves: a bench
tab in the widget with buttons for each state and a "play a turn" that steps
through one on timers. Clicking the buttons was smooth, playing a turn was not.
That difference is the whole diagnosis, and it took one message to obtain
against four rounds of measuring the wrong thing.

**The fix is not a layout effect.** Running the setup before paint would close
this particular window and leave the same disagreement available to anything
else that reads state during render. Moving the destination into a ref updated
beside the other two removes the possibility instead: before the effect all
three describe the finished previous fade, which is the colour already on
screen, and after it all three describe the new one. There is no ordering to
get right.

**Kept, from the same round:** the rim bench is behind `tuneRim` on
`<Interpreter/>` and `?tune` in the URL, off everywhere else. `space` and
`crossfadeMs` reach the rim whether or not the bench is driving it, so an
interpolation can be judged against another during a real conversation rather
than against a memory of one.

## 34. Anchor a flow step, and let it stop when it cannot find one

**Chosen:** a step targets by label and may be constrained by `data-testid` or
an authored `id`; a flow may declare the `page` it runs on; and a flow that
stops reports and stays stopped.

**Three defects, one run.** The agent was asked to create an availability. It
opened a dialog, did nothing else, and said nothing useful.

**A label is not unique and was never meant to be.** cal.diy labels the button
that opens a new schedule "New" and the one that opens a new event type "New",
and tells them apart by `data-testid`. The only write action in the manifest,
`createEventType`, began `click: "New"`. From the availability page that opened
the schedule dialog, spent four seconds looking for a field called "Title" that
a schedule dialog does not have, and stopped — three steps into the wrong
screen. Anchored to `new-event-type`, it stops at step one.

So `snapshot()` now reports `testId` and `domId`, and a step may carry either.
Every criterion present has to match; a criterion left out is not checked, so a
step with only a label behaves exactly as before. **Enrich, never require** —
apps write these on some elements and not others, and cal's own create dialog
is the honest case: of five steps, two have a test id and three have nothing
but their label. A rule that demanded anchors would have excluded the app that
motivated them.

`page` is the other half and a different guarantee: the identifier says WHICH
element, the page says WHERE the flow is valid. It is checked once before
anything is clicked, so a flow aimed at the wrong screen opens nothing at all.
They fail at different points, which is the reason to have both.

**And the flow's failure looked like it contradicted the session prompt.** Rule
6 says say what failed and stop. The flow's own result said "take a
dom_snapshot to see where it is rather than starting over". The prompt won --
it is in the session prefix and the hint is one tool result -- so the model
stopped, silently, and the user watched a dialog open and nothing happen.

The first fix rewrote the hint to say report-and-stop, which settled the
argument by deleting one side of it. That went too far, and reverting it is
what found the actual line: **the hint reads, the rule bans writing.** Taking a
snapshot is how the model tells the user something they can act on -- "the
dialog is open, nothing was saved". Finishing the job with `dom_click` is how a
manifest bug gets hidden. Those are different acts, and the original wording
only ever asked for the first.

So the hint is back as it was, and rule 6 carries the prohibition instead,
naming `dom_click` and `dom_type` rather than looking. Narrower than "do not
touch the DOM": reaching for `dom_click` when the manifest covers nothing is
still right; using it to repair a flow that has already gone wrong is not.

**What was actually broken was the silence, not the stopping.** The result
carried `could not find a field labelled "Title"` the whole time, and rules 4
and 6 squeezed it into one sentence that dropped it. Rule 6 now says to say
WHY, not just that. A flow that cannot find its own field is a manifest bug,
and the user is the one who can fix it — so they have to hear which part.

Two tests had to be rewritten across this, both asserting wordings. That is
what a test on a wording is for: it fails when the wording stops meaning what
it meant, which is the moment to check the decision still holds.

## 35. Point at it

**Chosen:** a `dom_highlight` tool that draws a ring around one element of the
host app and scrolls it into view, in a third overlay layer, tracked per frame.

An agent that is an expert in your app should be able to teach it, and teaching
means pointing. "Where is the submit button" answered in words -- "top right,
under the calendar" -- makes the user translate a description into a location,
which is the work they asked to be spared.

**Most of it was already built, for something else.** The overlay is a
viewport-sized fixed box in a shadow root, mounted outside the host's tree, in
the browser's top layer, with `pointer-events: none`. That is exactly what
drawing over an app you do not control requires, and every clause of it was
argued for the listening rim (§on the overlay). `pointer-events: none` turns
out to matter most: the ring must not eat the click on the thing it points at,
because the whole point is that the user presses it themselves.

**Per frame, and that is fine.** An element's rectangle moves on scroll, on
resize and on every re-render, so the ring follows it or it becomes a lie.
§31 measured the budget: an animated full-viewport gradient held a flat 60fps
and it was the ten-layer MASK that cost 21. One `getBoundingClientRect` and one
`transform` on a single element is nothing. Written straight to the node
through a ref rather than through React state, because a setState per frame
would re-render the subtree sixty times a second to move a box.

**Criteria, never a node.** React replaces nodes on almost every state change,
so a ring holding a node points at a detached element within a turn. It holds
what the element looked like -- the same `testId`/`domId`/`label` triple §34
added for flow steps -- and re-finds it. Which is the second time that triple
has paid for itself.

Re-finding deliberately does NOT call `snapshot()`, because that clears the
registry and would invalidate every `el-N` the model is holding. A ring
redrawing itself must not pull the ground out from under the next `dom_click`.

**A bug fixed on the way, which was worse than the missing feature.**
`isVisible()` excluded anything outside the viewport, so a snapshot stopped at
the fold and the agent could not see a submit button until the page happened to
be scrolled to it. Asked where one was, the honest answer from its own tools
was that there wasn't one. Split into "rendered" and "in the viewport": both
are reported, the second as an `offscreen` flag. Flows now prefer an on-screen
match and still reach one that is not, since scrolling is something we can do
and typing now scrolls the way clicking already did.

**Rule 3 says ACT, don't narrate, which is hostile to a tool whose job is to
show rather than do.** So rule 11 says pointing counts as acting, and adds the
part that is easy to get wrong: having drawn the ring, do not also describe the
position in words. And prefer pointing to pressing whenever the user is asking
to learn -- doing it for them teaches nothing and takes the click away from
someone who wanted to make it.

The ring clears when the user touches the page or when the model does anything
else. `dom_snapshot` is exempt, because looking is how it finds what to point
at, and clearing there would erase the ring it is about to draw.

**Made to look like the rest of it.** Four things, and only one is decoration.

The ring takes the ELEMENT'S OWN corner radius, plus its inset, so a ring
around a pill is a pill and a ring around an avatar is a circle. A fixed radius
is the tell that a highlight was drawn by something that never looked at what
it was pointing at. `calc()` handles it because a computed radius is `8px` on
most things and `50%` on a circle and both are legal inside one; an elliptical
corner computes to two values, which calc cannot take, so those pass through
unchanged rather than dropping the radius and squaring off a circle.

The halo is the RIM'S OWN FALLOFF, rescaled from 80px to 20px. Not a second set
of hand-picked numbers: it is the same error function, and reusing it is the
one kind of family resemblance that cannot quietly drift apart. Each stop
becomes a spread ring, and every ring is blurred by a quarter of the halo --
which is the part that had to be measured by looking. Eleven hard-edged rings
across twenty pixels are visibly eleven rings, stepped, worst around a corner
where they fan out. A blur wider than the gap between stops merges them back
into the smooth decay the numbers describe.

It enters on the PANEL'S SPRING, bounce 0 over half a second, scaling in from
slightly wide the way a lens finds focus. Two pieces of one widget arriving
differently is what makes a thing feel assembled rather than designed.

And it breathes on the HALO ONLY, never the ring. Scaling an outline drifts it
off the thing it is framing, which is the single impression a pointer cannot
afford.

Position and entrance live on two nested elements on purpose. The frame carries
position, written straight to the node every frame; the ring inside carries the
spring. One element would have framer and the follow loop both writing
`transform`, and whichever wrote last that frame would win.

Measured at 1280x800: 60fps with no ring, 60fps with a ring, and 60fps with a
ring while the page scrolls, which is the case that repaints the blurred halo
every frame. The budget §31 established holds.

**A dev-harness trap worth naming.** Driving this from outside the page by
importing `domActions.js` at its URL got a SECOND copy of a module that holds
state: Vite appends a cache-busting query after a hot update, so the components
had subscribed to one instance and the check was writing to another. The layer
mounted, the stylesheet injected, and nothing ever appeared. The harness now
exposes its own instance on `window`.


## 36. Borrow a browser, behind a seam

**Chosen:** the readiness signal is measured by a probe stage, driven through a
browser the developer already has, behind a driver contract.

**Why not static analysis.** §35's `readyWhen` has to name an element that
exists only once content has arrived, and the source does not contain it. In
cal.diy 0 of 79 page files hold a loading state -- the pages are thin and the
loading sits several imports away -- and the marker chosen by hand,
`Sunday-switch`, appears in the source as ``data-testid={`${weekday}-switch`}``.
Deriving it means evaluating a map over a weekday array, not parsing. 124 of
cal's test ids are built from expressions like that against 472 literals. And
even with a candidate in hand, nothing in the source says whether it renders
DURING loading or after. Readiness is a claim about time, and time is not in
the file.

**Why a probe and not an agent.** An agent for judgements, a probe for
measurements. "What is this page for" is a judgement. "Which element arrives
late and stays" has a mechanical procedure and no decision in it, so an agent
would add cost and variance and nothing else.

**Borrowed, not shipped.** puppeteer-core bundles no browser: 12MB, against
262MB for Playwright's Chromium and 162MB for Lightpanda's binary. It is found
in this order -- an explicit `VOICE_BROWSER`, a real installed browser, `PATH`,
then the caches a testing tool already filled. That last one is what matches
for most web developers, and finding it required looking under
`XDG_CACHE_HOME` as well as `HOME`, which are different on Linux and were
different here.

**Lightpanda was measured, not dismissed.** It runs the app: fetching cal's
login page gave 3 buttons where the server HTML has 1, and the labels come out
right. But it has no layout engine, which is how it is fast:
`getBoundingClientRect()` returns a 5x5 stub for every element and
`getComputedStyle().display` returns `block` for every element. On the same
page a real browser correctly identifies 2 of the 8 controls as hidden. A
readiness probe measures what EXISTS over time and does not care; an agent
choosing what to press would care enormously. So the contract makes visibility
explicitly nullable rather than letting a stage assume, and both engines stay
possible.

**The seam is the point.** `browsers/contract.js` is four methods and one
evaluated script. A stage that reached for a Puppeteer handle would end the
seam, so the shared inventory script lives in the contract and every driver
returns the same shape. `browsers/fake.js` is the same argument as the fake
data channel: a test says what the page did over time and asserts what the
stage concluded, with no browser anywhere.

**Two bugs the first real run found, both of them mine.** The furniture filter
compared first samples, so cal's dev overlay -- which mounts late on every page
-- was proposed as the signal for 20 of 23 routes. And the redirect check ran
only before sampling, so 34 routes that bounce to login after DOMContentLoaded
were measured as themselves. Neither would have shown up against a fake.

## 37. A dispatcher and a tool tree, not one typed tool per operation

**Chosen:** operations are reached through `run_query`, `run_action` and
`expand`, called by name, with the catalog of what-can-be-called living in the
prompt as text and grouped into an expandable tree. The old typed
`query_*`/`action_*` functions are gone.

**Alternative:** keep one typed function per operation, and lean on a
human-written `include` list to keep the count down.

### Why

cal.diy yields 177 operations. As typed tools that was ~22k tokens of prompt
prefix on **every response**, and a live session showed the cost directly: 13
of 26 responses failed on the per-minute rate limit, one assistant reply in
five and a half minutes. The tools also cannot be trimmed mid-session -- they
are fixed at creation for prompt caching -- so a "reveal more tools when needed"
step cannot add typed functions later. Both problems have the same root: the
whole tool surface rides in the prefix, sized by the app.

Making the operations DATA fixes both. The tool surface is a handful of
dispatchers whatever the app's size, and what an operation costs is one catalog
line, not a full JSON schema. Measured on the same all-root cal manifest:
**~22k tokens down to ~7.5k**, a 3x cut before any grouping at all.

Grouping is the rest of the win. Each operation carries an optional `group`
path; no group means the root, and root operations ship in the base prompt.
Everything else is an `expand(topic)` away, and expand is answered from the
manifest the widget already holds -- no round trip. A deep app is a deep tree,
so niche tools take a few expands to reach, which is the point: context fills
with one topic's tools when asked, never with all of them.

### What it costs

- **Calling by name is looser than a typed function.** A typed tool's
  arguments are schema-checked by the model's own tool-calling; `run_query({name,
  args})` puts the operation name in a string, so a wrong name is caught at
  dispatch and returned as an error rather than being impossible. Worth it for
  the token saving, and the error is actionable.
- **The tree is only as good as the grouping**, and nothing groups yet.
  Generate and probe leave every operation at the root -- valid, works on the
  first try, and back to the heavy end of the range until a classifier (human
  or agent, per DESIGN-PHILOSOPHY §3) moves operations into topics. The
  dispatcher is the mechanism; the classifier is the payoff, and it is the next
  piece.
- **The grouping logic exists twice**, once in the relay (renders the root) and
  once in the widget (answers expand). Same data model, two views; a shared
  spec comment in each. Acceptable while it is ~30 lines, worth unifying if it
  grows.

Everything a manifest carried before still works: the `describeReturns` hint, a
DOM flow's "happens on screen" note, and the destructive marking all moved into
the catalog line rather than the typed description.

## 38. Follow a schema across packages; surface why a call was rejected; stop a doomed retry

Three fixes from one failed session: the model correctly found Weekend Warrior,
called run_action to update it, and failed 18 times with 14 different guessed
shapes because the manifest gave `availabilityScheduleUpdate` no body fields and
the error said only "Invalid input".

**The manifest was empty because the schema lives in another package.** The tRPC
router says `.input(ZUpdateInputSchema)`, but that name is
`export { ZUpdateInputSchema } from "@calcom/features/.../ScheduleService"` -- a
re-export, to a z.object in a different package. The old reader searched for a
local `const ZUpdateInputSchema = z.object(...)` and found nothing.

The fix is a general, schema-AGNOSTIC symbol resolver (`core/resolveSymbol.js`):
given a symbol and the file that references it, follow imports and re-exports --
across package boundaries via the workspace's own `@scope/name` aliases -- to
the AST node that defines it. What the node MEANS is the caller's business, so
the same resolver serves a Zod reader today and a Yup or plain-type reader
later; only the interpreter at the end differs. This is DESIGN-PHILOSOPHY §1 and
§3 in one: static analysis does the finding, and the finding is reusable.
Result on cal: body fields for 53 of 89 actions, all resolved across packages,
including the update that had been unguessable.

**The rejection reason was thrown away.** tRPC's error carries
`zodError.fieldErrors: { scheduleId: ["Required"] }` -- the exact fix -- and the
transport flattened it to the top-level "Invalid input". Now surfaced as
"Invalid input (scheduleId: Required)", which is self-correcting: the model that
sent `id` learns the field is `scheduleId`. A validation error the model can
READ is worth more than any number of retries.

**A doomed retry is capped.** A model that keeps failing the same action the
same way is not making progress, and 18 attempts proved it. The widget tracks
consecutive identical failures (keyed on action AND error text, so a DIFFERENT
error -- one field corrected, the next revealed -- resets the count as the
progress it is) and after a few returns a firm "stop and report", breaking a
loop that would otherwise burn the session.

**Also fixed on the way:** the Zod field-type unwrap read `timeZoneSchema.optional()`
as type "optional" -- a wrapper leaking in where the base is a referenced schema
rather than a `z.<type>()`. It now descends to the real base or keeps the
default, so `timeZone` reads `string`, not `optional`.

## 39. A field's nested shape, not just "array"

The write from §38 got its field NAMES but still failed: the model sent
`schedule: [{days, startTime, endTime}]` where cal.diy wanted
`Array<Array<{start, end}>>` -- a weekday-indexed array of arrays of time
ranges. The manifest said only `schedule: array`, so the model copied the flat
shape it saw in the read result and guessed wrong every time.

The Zod reader now recurses arrays and objects into a compact type, carried on
the field as `shape` and rendered in the catalog line:
`schedule?: Array<Array<{ start, end }>>`. A scalar carries no shape -- its
`type` already says "string" -- so only compound fields cost the extra tokens.

Depth-capped at three levels. Full depth would occasionally reproduce a large
nested schema in the very prompt the dispatcher work shrank, and three levels
covers anything a person would hand-type. Past it, the type is just
`array`/`object` again.

This is the last layer of one onion: reaching a write on cal's schedule needed,
in turn, the tRPC envelope (§the transport fix), the dispatcher (§37), a legible
catalog (§37 follow-up), cross-package field names (§38), the rejection reason
(§38), and now the nested shape. Each is general; the task just happened to
exercise all of them.

## 40. Not every error is worth a retry; and a window to watch a run

Two things a painful-but-successful session made obvious.

**Errors split by whether a retry could succeed.** A rate limit says "try again
in 8s" and the wait IS the fix. A validation error ("schedule: Expected array")
will reject the identical call forever. Treating them alike made the agent burn
four attempts on a doomed write -- and, worse, each retry re-sent the whole
conversation and spent the token budget again, pushing the rate limit deeper so
every later step waited longer. `classifyError` splits them: transient (rate
limit, 5xx, network) is retried; validation (400/bad input) and fatal
(401/403/404) are cut off on the FIRST strike with advice to change the shape
substantially or use the DOM tools instead. Unknown errors stay
possibly-transient, so a real one is never wrongly abandoned. This is also why a
session paced so strangely: the rim's stop-start is the agent waiting out a
rate-limit backoff between almost every action, and fewer doomed retries means
fewer of those waits.

**A session observer.** The logs were only readable by grepping JSONL. A small
relay page (`/voice/observer`, behind VOICE_LOG) lists sessions and renders one
turn by turn -- user, agent, tool call with args and result, and every
response_failed with its retry badge -- each with its offset and the gap since
the last. It reads the logs and never writes them, and lives on the relay
because that is where they are written. It immediately earned its keep: it
showed the model's first schedule attempt was an object keyed by day name, a
shape the raw log made no faster to see.

## 41. Confidence: how much we trust an operation's API path -- and the seam we left open

A single failing task -- "make the Weekend Warrior weekends only" -- exposed a
whole spectrum of "we don't know this well enough to just call the API", and
this section is both what we built for it and, at the end, an explicit note of
what we deliberately did NOT build, so it is not lost.

**Two kinds of not-knowing.** *Encoding* knowledge is written truthfully in the
schema and is fully mechanisable: cal.diy's `start`/`end` are `z.date()` over a
superjson transport, so the request has to carry the ISO string AND the
`["Date"]` tag superjson revives it from -- send the string alone and `z.date()`
rejects a perfectly valid date forever. We fixed that in code (the transport
tags declared date fields; the CLI records their paths, arrays transparent). But
*semantic* knowledge is written nowhere a parser reaches: that `name` is
required in practice though the schema marks it optional (the handler does
`if (!input.name) return`), that `schedule` is a 7-slot array indexed
0=Sunday..6=Saturday with `[]` for a closed day. That cannot be extracted; it
can only be judged.

**So we grade, rather than pretend to know.** Four detectors, tuned for recall
because a false positive costs a reviewer one glance and a miss is a silent
runtime failure:

- *opaque* -- meaning rides on position or an unlabelled code (a nested array, an
  array of objects with no identifying field, a fixed-length list of bare
  values). cal.diy's weekday `schedule` is the reason it exists.
- *unknown* -- the shape itself is undetermined: `z.any`/`unknown`/`record`, or a
  write with no readable body at all. Its reason names WHERE to look (an
  unresolved schema symbol, a hook's form, or the handler).
- *truncated* -- the prompt render stopped at the depth cap, so the model is shown
  a partial shape. Fixing this also closed a real hole: date extraction had
  shared the render's depth cap, so a date below it silently lost its tag.
  Knowing and showing are now separate jobs -- dates extract to full depth, the
  render stays shallow.

These flags are build-time metadata for a reviewer and a dispatcher; they never
reach the model (both expand paths strip them), because raw uncertainty in the
prompt only saps the model's confidence.

**One word the runtime can act on.** A policy stage collapses the flags -- and
the read-back probe's verdict, when present -- into `confidence`:
`known | review | unknown`, `known` left off to save bytes. The probe outranks
the static guess: a fixture that truly changed state promotes to `known`, a
2xx-that-changed-nothing demotes. That one word drives three things off one
signal: the prompt marks the operation (`[screen first]`, `[screen only]`), the
retry budget tightens (an `unknown` body is a guess a retry only re-sends), and
on a low-confidence failure the dispatcher steers to the screen itself --
softly ("try doing it on the screen"), with a way out so it does not loop --
rather than leaving the model to remember the screen exists.

**The read-back probe.** The piece that makes `review`/`unknown` more than a
guess. A status says a write was accepted; only reading the state back says it
did anything. The probe sends a write and reads a chosen value before and after:
a change is a verified effect, a 2xx that moved nothing is the silent no-op that
condemns the API path. The payload cannot be synthesised (to know one that works
is to already know the contract the no-op hides), so it comes from a fixture --
the natural call a person would make -- and a fixture that turns out to be a
no-op IS the finding.

**The seam we deliberately left open -- the human/LLM judgement pass.** The
machinery above runs entirely off the static verdict; it needs no judgement to
work today. But two things are stubbed rather than built, and both attach to
fields that already exist:

1. *Resolving a flag into a note.* An `opaque`/`unknown` operation is flagged,
   not explained. A human or an LLM agent reads the source the reason points at
   and writes the real contract -- "always send `name`; `schedule` is a 7-slot
   array, 0=Sunday..6=Saturday, `[]` for closed" -- into the operation's
   description and (via `verified`) its confidence. The read-back probe then
   confirms it (a fixture WITH the note passes) and promotes it to `known`. The
   flag triggers the pass; the probe closes it. What is missing is only the pass
   itself: a skill an agent runs and a procedure a human follows, writing into
   the overlay's description/group/confidence fields the manifest already
   carries.

2. *Recording DOM flows.* "DOM-first" today is satisfied AGENTICALLY -- the steer
   tells the model to navigate and drive the controls, because cal.diy has no
   recorded flows. A recorded flow (a manifest operation with `transport: "dom"`
   and `steps`) is a tool the model can call directly instead, turning
   `[screen first]` from "figure it out on the page" into "run this". Capturing
   those flows -- from a person doing the task once, or an agent driving the UI
   and recording the steps -- is the same judgement pass wearing a different hat,
   and it plugs into the `dom` transport that already exists and already runs
   (`perform` executes `steps` today; nothing produces them yet).

Neither is a crutch the machinery is waiting on; both are the third stage of
DESIGN-PHILOSOPHY 3 -- judgement -- shipped as something an agent or a human
does, into fields that are already first-class. This section is the marker so we
pick them up deliberately rather than rediscover the gap.
