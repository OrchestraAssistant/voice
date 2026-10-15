# voice-mvp

Voice control for React apps. Static analysis turns an app into a manifest of
what it can do; a relay mints realtime-voice sessions with that manifest as
the tool list; a widget executes the calls in the browser — manifest-driven
first, DOM fallback second, with a confirmation gate on destructive actions.

**Working end to end today**, against the real OpenAI Realtime API.

| doc | for |
|---|---|
| this file | orientation, running it, gotchas |
| [SPEC.md](SPEC.md) | what the system is and how the parts fit |
| [DESIGN-CHOICES.md](DESIGN-CHOICES.md) | decisions, alternatives rejected, revisit conditions |

---

## Layout

The pieces split by what ships and to whom. **This split is the thing to
internalise first** — conflating it caused real confusion before it existed.

```
packages/voice/        THE PRODUCT. React widget: VoiceProvider, useInterpreter,
                       InterpreterBubble/Panel, ListeningGlow, ScreenOverlay.
                       Ships to devs as @expert/voice (built to dist/).
                       dev/ holds two harnesses, neither published: stress.html
                       (hostile host) and bubble.html (clean host, for the panel).

packages/voice-cli/    THE TOOLING. Babel extractor: app source → manifest.json.
                       Ships to devs as @expert/voice-cli.

packages/voice-server/ THE SERVER HALVES. Mountable Web handlers that hold the
                       keys (the OpenAI relay, the JEV broker). Ships to devs
                       as @expert/voice-server.
```

Two more pieces are part of the product but live outside this repo and ship to
nobody: a **relay** — your service (or Orchestra's hosted one), which mints
ephemeral OpenAI tokens and owns the tool list + confirmation policy; devs just
get a URL, not its source — and a **demo app + API** that consumes
`@expert/voice` exactly as a customer would, its API standing in for the
customer's backend. That demo deliberately uses **no Tailwind** — it is the
only thing proving the compiled package stands alone in a host that doesn't
share our build setup, and it is what caught the CSS-collision bug in
DESIGN-CHOICES §1.

## Installing it in your app

Not on npm yet, and `npm install github:OrchestraAssistant/voice-mvp` won't work
— this is a workspace monorepo, so that grabs the private root, not the packages.
Install the two **tarballs** instead. They're pre-built (`dist` is bundled), so
the host needs no build step and no Tailwind:

```bash
# from a GitHub Release (shareable, no clone):
npm install \
  https://github.com/OrchestraAssistant/voice-mvp/releases/download/v0.1.4/expert-voice-0.1.4.tgz \
  https://github.com/OrchestraAssistant/voice-mvp/releases/download/v0.1.4/expert-voice-cli-0.1.4.tgz

# or from local tarballs, built in this repo with `npm run pack:all`:
npm install ./expert-voice-0.1.4.tgz ./expert-voice-cli-0.1.4.tgz
```

Then generate a manifest from your source:

```bash
npx voice-cli src .voice     # your source dir -> .voice/manifest.json
```

Maintainers: `npm run pack:all` writes both tarballs to `pkg/` (`@expert/voice`
builds its `dist` on pack). Attach those two files to a GitHub Release named
`v0.1.4` and the URL install above works for anyone.

Mount it once, wherever your other providers live. It is a leaf, not a
wrapper -- nothing of yours needs to be inside the provider, because the only
components calling `useInterpreter()` are the widget's own and its chrome
portals into an overlay on `document.body`:

```jsx
import { VoiceProvider, Interpreter } from "@expert/voice";
import manifest from "./.voice/manifest.json";

<VoiceProvider
  manifest={manifest}
  navigate={yourRouterPush}
  // Refresh your data after a voice write, or the change only shows on reload:
  onAfterAction={() => queryClient.invalidateQueries()}   // your cache; e.g. react-query / tRPC utils.invalidate()
>
  <Interpreter />
</VoiceProvider>
```

`onAfterAction` matters more than it looks. A voice write hits your API
out-of-band, so your client cache does not know and the UI sits stale until a
refetch -- the classic "it only showed after I refreshed". Wire it to the same
cache-invalidation your own mutations already do (`queryClient.invalidateQueries()`,
`utils.invalidate()`, `router.refresh()`, `mutate(() => true)`), optionally
surgical via the action name it is passed: `onAfterAction={({ name }) => ...}`.
Skip it and we synthesise a focus event, which most React-Query/SWR apps refetch
on -- so it usually still updates, just less precisely.

The manifest is yours, not the relay's. It is generated from your source,
committed beside your code and bundled with your app, so it cannot describe a
version of the app that is not the one running. The widget executes tool calls
against it and sends it with each session request; the relay builds the
model's tool list from that and stores nothing. One relay can therefore serve
any number of apps, and there is no per-app configuration on it to get wrong.

Wrap your tree instead only if you want to call `useInterpreter()` in your own
components, to build custom UI against the same session.

### Three tiers, pick one

`<Interpreter/>` is the top of three, and each tier below it is the one above
with a piece taken away. Drop a tier when you want something the tier above
decided for you.

| | you get | you write |
| --- | --- | --- |
| `<Interpreter/>` | the bubble and the rim, assembled | one line |
| `<InterpreterBubble/>` + `<ListeningGlow/>` | the pieces, placed your way | derive `rimState()` yourself and render both |
| `useInterpreter()` | the session, no UI at all | everything |

The middle tier is the one to be careful with. Rendering the bubble without
the rim is not an error and nothing warns about it -- the app just has no
ambient feedback, and it looks finished. That is what happened on the first
real integration, which is why the top tier exists.

**Do not import the stylesheet.** The default shadow mount needs no CSS import —
the widget renders into its own shadow root and injects its compiled CSS there.
The sheet is exported as `@expert/voice/inline.css` (deliberately not
`styles.css`, so the reflexive import fails loudly instead of breaking layout),
and it exists for `mount="inline"` on a NON-Tailwind host only: in a Tailwind
host document it shares a global class namespace with your app — a bare
`.hidden` from it landed after a real app's
`.md:flex` in the same cascade layer, and since media queries carry no
specificity, that app's desktop sidebar stayed hidden at every width and the
whole layout fell back to its mobile bar. Prefer the default mount.

Your app also has to reach the relay. Same-origin is simplest -- proxy
`/voice` to it in your dev server and at your edge -- because a page served
over TLS cannot call an `http://` relay without being blocked as mixed
content. Otherwise pass `relayUrl`.

### Securing the relay

The relay mints tokens billed to your OpenAI account, so an exposed
`/voice/session` is an open, billable proxy. It runs open on localhost (and
prints an `UNPROTECTED` warning at startup); before you expose it, set:

- `VOICE_RELAY_SECRET` — the real lock. Requires a shared secret (as
  `Authorization: Bearer …` or `X-Voice-Secret`) on `/voice/session` and
  `/voice/log`. Have your app's OWN backend inject it where it proxies `/voice`,
  so the secret never reaches the browser — a secret shipped to the page is not
  a secret.
- `VOICE_ALLOWED_ORIGINS` — comma-separated origins allowed cross-origin.

A per-client rate limit (`VOICE_RATE_LIMIT`, default 30/min; `VOICE_RATE_WINDOW_MS`)
and a request-body cap (`VOICE_MAX_BODY`, default `256kb`) are always on; behind
a TLS proxy set `VOICE_TRUST_PROXY=1` so the limiter sees the real client.

### Host the backend in your own app (no separate relay)

You don't need to run the relay standalone. Install `@expert/voice-server` (the
server halves of the providers) and mount one route in your own backend — the key
lives there, and the route sits behind your app's existing auth. **The recipe is
the same for every engine: set the keys in env → mount the provider's handler at
`/voice` → point the client at `/voice`.**

```bash
npm install @expert/voice-server   # or the v0.1.4 tarball URL, like the others
```

```ts
// OpenAI Realtime — app/voice/[...path]/route.ts (Next.js App Router)
import { openaiVoiceHandler } from "@expert/voice-server/openai";
const handler = openaiVoiceHandler();        // reads OPENAI_API_KEY from env
export const GET = handler;                   // serves /options, /session, /log
export const POST = handler;
// client: <VoiceProvider relayUrl="" …>  (empty = same origin)
```

**Guard the route.** `/voice/session` mints tokens billed to your key, so an
unauthenticated public route is an open, billable proxy. Mounted behind your
app's auth it already is gated — pass `{ trustAuth: true }` to say so. If it is
not, lock it with the handler's opt-in guards; either way the handler **warns
once at startup when it sees no guard** so the mistake is loud, not silent:

```ts
openaiVoiceHandler({
  requireAuth: (req) => isLoggedIn(req), // your check; false → 401 before minting
  // or a shared secret your own backend injects (never shipped to the page):
  secret: process.env.VOICE_SECRET,      // Bearer <s> or X-Voice-Secret on /session,/log
  rateLimit: 30,                         // per-client/min (on by default; false to disable)
});
```

```ts
// JEV cascade (browser STT + JEV + a text model) — app/voice/[...path]/route.ts
import { jevBrokerHandler, openaiText } from "@expert/voice-server/jev";
export const POST = jevBrokerHandler({ generate: openaiText() }); // JEV_API_KEY + OPENAI_API_KEY
// client (install @huggingface/transformers; moonshineStt REQUIRES loadTransformers):
//   const stt = moonshineStt({ loadTransformers: () => import("@huggingface/transformers"), size: "base" });
//   provider={moonshineJev({ stt, ...jevBroker("") })}
```

Both expose `toExpressHandler` for non-Web backends (`app.use("/voice",
express.json(), toExpressHandler(handler))`). For a single app this beats a
standalone service — same origin, your own auth gating the route, one deploy. The
standalone relay stays the reference + the multi-tenant option (one service for
many apps), where its origin / secret / rate-limit guards earn their keep. Full
contract and the three server shapes (mint vs per-turn proxy vs long-lived) are
in PROVIDERS.md.

### Swap the engine, or offer several

OpenAI Realtime is the default, but the voice-to-action pipeline is a swappable
**provider** (`{ id, capabilities, connect }` — see PROVIDERS.md). Pass one with
`provider=`, or pass a list the user can pick from in Settings, exactly like the
model picker but one level up:

```jsx
import { VoiceProvider, openaiRealtime, moonshineJev, moonshineStt, jevBroker } from "@expert/voice";

// Moonshine's speech model runs in the browser via transformers.js — a heavy
// optional dep the core does NOT bundle, so install @huggingface/transformers and
// pass it. Without loadTransformers the widget errors ("moonshineStt needs …").
const moonshine = moonshineJev({
  stt: moonshineStt({ loadTransformers: () => import("@huggingface/transformers"), size: "base" }),
  ...jevBroker(""), // the broker route above supplies evaluate + generateText
});

<VoiceProvider
  manifest={manifest}
  providers={[
    { label: "OpenAI Realtime",       provider: openaiRealtime({ relayUrl }) },
    { label: "On-device (Moonshine)", provider: moonshine },
  ]}
>
  <Interpreter />
</VoiceProvider>
```

The app offers only the engines it has wired (each needs its own server half — a
relay, a JEV/STT broker); the user chooses among them. Switching is a reconnect
(an engine is a whole pipeline, not a parameter), the credential is dropped, and
the controls follow the engine's `capabilities` — an engine that can't
push-to-talk simply won't show the button. To see it with no keys, run the dev
harness at `dev/bubble.html?providers=multi` (two fake engines,
`dev/fake-providers.js`).

## What the CLI understands

`voice-cli` reads your source statically — no build, no running app. Each
detector fires only when it recognises its pattern, so they compose: a Next app
on tRPC with Zod, or a React-Router SPA on axios with plain TypeScript types,
both come out as one manifest. Anything no detector sees falls through to the
**DOM tier** at runtime (snapshot → click/type), so an unrecognised stack still
works — just without the typed shortcuts. Every stage that fired, and every one
that found nothing and why, is printed on each run.

"Verified on" names a real open-source app the detector was run against in a
coverage sweep; "fixture" means it is covered by tests but has not yet had a
real-app run.

**Routing**

| stack | detector | verified on |
|---|---|---|
| React Router (`<Route>` JSX) | `react-router` | twenty |
| React Router v7 config / `createBrowserRouter([...])` | `react-router-config` | plane |
| TanStack Router (`createFileRoute` / `createRoute`) | `tanstack-router` | fixture |
| Remix file-system routes | `remix-fs-routes` | fixture |
| Astro pages | `astro-pages` | fixture |
| Next.js App Router & Pages Router | `next-app-router`, `next-pages-router` | cal.com |

**API & data layer**

| stack | detector | verified on |
|---|---|---|
| tRPC routers | `trpc-routers` | cal.com |
| REST via axios service classes | `axios-services` | plane |
| GraphQL operations (`gql` tagged templates, cross-file fragments inlined) | `graphql-operations` | twenty |
| OpenAPI / Swagger JSON spec | `openapi-spec` | fixture |
| React data hooks (`useQuery`/`useMutation` + a fetch helper) | `request-hooks` | fixture |
| Next route handlers & Pages API | `next-route-handlers`, `next-pages-api` | cal.com |
| TanStack Start server routes (`createAPIFileRoute`) | `tanstack-server-routes` | fixture |

**Request bodies & typing** — fills in what an operation accepts

| source | enricher | verified on |
|---|---|---|
| Zod schemas | `zod-bodies` | cal.com |
| TypeScript types / interfaces (incl. `Partial<T>`, cross-package) | `typescript-types` | plane |
| Valibot / Yup / ArkType schemas | `valibot-bodies`, `yup-bodies`, `arktype-bodies` | fixture |

A body the source types as `any` cannot be read: the CLI says so and steers that
operation to the screen rather than inventing its fields — honest over hopeful.

**Large apps.** The session prompt lists every *root* operation, so its size
tracks how many operations sit at the root. Small and mid apps keep everything
at root — immediately callable, the deliberate default. Above a budget, the
generator's **grouping pass** clusters operations into topics by entity (read
from the name), moving the long tail behind `expand` and leaving the base prompt
a handful of lines; measured, this cut a 329-operation app from ~20k to ~7k
tokens of prefix and a 310-operation one from ~11k to ~6k, with no hand-tuning.
You can still override it in `manifest.overlay.json` — a hand-written `group`
path or an `include` list is respected as the floor.

**Versioning & staleness.** Each manifest is stamped with a `version` (the
format, which the server checks for compatibility) and a `contractHash` — a hash
over only the *callable surface* (operation names, methods, endpoints, param and
body shapes, route paths, confirmation tiers, agent wiring). Re-wording a
description or re-grouping the catalog leaves the hash unchanged; renaming an
operation, moving an endpoint or flipping a confirmation tier changes it. So a
manifest that no longer matches its source is caught in CI with a one-line gate
— `voice-cli --check` regenerates, compares the committed hash, and exits
non-zero (naming what drifted) if the two differ.

## Run it

```bash
npm install          # workspaces
npm run build:pkg    # @expert/voice → dist/  (REQUIRED after any package edit)
npm run dev:stress   # dev harnesses  :5174   (/stress.html and /bubble.html)
```

Open http://localhost:5174/stress.html or /bubble.html — the two dev harnesses,
the only pages this repo serves.

`bubble.html` is the panel's workbench, and exists because the real widget
lives in a **closed** shadow root that no selector and no devtools query can
reach into. It mounts the bubble `inline` on a page with no opinions of its
own, which renders identically and *can* be driven and inspected.
`?mount=shadow` switches to the real overlay path, `?bg=dark` puts it on a
dark background — the fastest way to catch a surface that is actually
transparent — and `?trace=1` records the animated container and the measured
wrapper frame by frame after each click, which is the only practical way to
debug the resize. Healthy looks like `inner` holding steady while `outer`
moves toward it; `inner` moving too means the content is reflowing mid-
transition and the panel will visibly overshoot, and `inner` reading as the
*sum* of both panes means the outgoing one never left the flow.

`?glow=1` mounts the listening rim alongside the panel, which is the only way
to reproduce anything about how our *two* overlays interact — each is its own
top-layer popover, and that pairing has its own failure mode (see the gotcha
below). With `?trace=1` the page also counts `toggle` events: a handful is
healthy, thousands means two overlays are re-raising each other.

Selectors still can't drive the panel from outside: `document.querySelector`
does not descend into a shadow root even an open one, and a click on this page
would close the panel via click-outside before any proxied click landed. So
the harness drives it from the keyboard: **1** toggles the Talk tab, **2**
toggles Settings, and **3** dispatches a press *inside* the panel, which must
not close it.

**Verify in the shadow root, not just inline.** A bug can be invisible at
`mount="inline"` and present in every build that ships — see DESIGN-CHOICES
§1 on runtime-injected stylesheets, which cost a round of "fixed" that
wasn't.

### Try it

Click the mic pill (bottom-right) → panel opens with **Talk** and a **cog**.
Talk starts the session; the cog holds mic modes. Then:

- "What tasks do I have?"
- "Create a task called buy milk, due tomorrow"
- "Delete the task about the Q3 report" → **must ask you to confirm first**

There's a text box in the panel that runs the same tool pipeline without a
mic — genuinely useful for testing logic, though it needs an active session
(so mic permission is still granted; it just skips talking).

`?glow=1` forces the listening rim on without a session.
`?mount=inline` renders the widget in the host's DOM instead of the shadow
root — a live A/B of the CSS-collision problem.

## Gotchas that have actually bitten

- **`npm run build:pkg` after every package edit.** The dev harness resolves
  `@expert/voice` to `dist/`, not `src/`. Editing the package and reloading
  the browser shows nothing until you rebuild.
- **Regenerating the manifest overwrites hand-corrections.** There's no merge
  step. When the extractor gets an operation wrong you fix it by hand, and the
  next regenerate wipes those fixes unless you reapply them. `handEdited` in the
  file flags this.
- **Tailwind's scanner reads comments.** Quoting a class name in prose emits
  CSS for it. ~1KB of dead utilities in `voice.css` come from exactly that.
- **Preflight is excluded on purpose** (it would restyle the host's document).
  Pasted shadcn/skiper components assume it exists — if one looks subtly
  wrong, suspect this first. We ship a preflight-equivalent reset scoped to
  our own roots instead.
- **Duplicate dev servers.** Starting `dev:stress` twice makes Vite silently
  bind :5175 and you can end up looking at a different instance than the one
  you're rebuilding. `ps aux | grep vite` before debugging a "nothing
  changed" mystery.
- **`rimTuningDev.js`** is temporary (rim geometry sliders in the flat panel).
- **All chrome shares one overlay.** `VoiceProvider` mounts it; the rim and
  the panel each claim an ordered layer inside it via `useOverlayLayer`. Two
  hosts could not agree an order in the top layer without re-raising
  themselves at each other, which was a ~1800-events-a-second loop seen as the
  panel flickering above and below the rim. Watch the counter in
  `bubble.html?mount=shadow&glow=1&trace=1`: a handful is healthy.
- **`document.head` is the wrong tree.** Anything injecting a stylesheet at
  runtime must be told to put it in the shadow root. It fails silently
  otherwise, and only in the build that ships.
- **A widget that renders but looks unstyled** is almost always one of the
  three cascade traps in DESIGN-CHOICES §3, not a React problem: theme tokens
  reaching `:root` where `--iv-*` isn't defined, our own rules sitting
  unlayered above `@layer utilities`, or Tailwind scanning the wrong root.

## State of the UI work

`InterpreterBubble` is a port of skiper-ui's skiper96 expanding-tabs
component. The layout and animation mechanics are now that component's
**unchanged** — measured wrapper, `popLayout`, `key={selected}`, tab strip
absolutely positioned inside the measured div.

Four deliberate differences remain:

1. **One tab closed, two open.** Closed, the pill is just the mic; Settings
   only joins the strip once the panel is open, so idle chrome stays as small
   as possible. Tab indices are fixed (talk 0, settings 1) so `selected`
   survives the array growing.
2. **Widths 56→290** (theirs: 200→290). Only the collapsed width differs, and
   only because ours collapses to a single-icon pill rather than five.
3. **Outline icons** — no `fill-current`; it floods lucide's stroke-only
   paths and turns a cog into a blob.
4. **Our content** in the panes, built from the same row/list vocabulary the
   original uses, so the shell and its contents stay of a piece.

If you touch this, change one thing at a time and compare against the
original — a long detour here came from stacking "fixes" on top of my own
earlier modifications instead of reverting to the source structure.

## Testing

`npm test` builds the package and runs both suites (16 tests, about a minute).

```
packages/voice/test/stylesheet.test.mjs   the compiled CSS, no browser
packages/voice/test/widget.test.mjs       real layout, real shadow root
```

The browser suite is not decoration. Every bug it covers shipped, and every one
of them looked correct in a screenshot: a transparent panel over a white page
looks like a white panel, a 350ms overshoot is invisible in a still, and a
stacking failure inside the shadow root behaves perfectly at `mount="inline"`.
So the tests assert numbers, and they drive the mount that ships rather than
the convenient one.

It runs Playwright against a Vite dev server on an ephemeral port, so it never
collides with `dev:stress`. Reaching into the widget asks for `.shadowRoot`
deliberately, which works because the root is open; a plain `querySelector`
does not descend into one.

**Browser setup.** The bundled Chromium needs shared libraries and fonts this
read-only image lacks. They live in a micromamba env, and `test/harness.mjs`
puts them on `LD_LIBRARY_PATH` / `FONTCONFIG_PATH` before launching, so
`npm test` needs no wrapper:

```bash
micromamba create -y -n browser -c conda-forge \
  glib nss nspr atk at-spi2-atk at-spi2-core dbus expat libdrm libxcb \
  libxkbcommon xorg-libx11 xorg-libxcomposite xorg-libxdamage xorg-libxext \
  xorg-libxfixes xorg-libxrandr xorg-libxtst pango cairo alsa-lib libgbm \
  libcups fontconfig font-ttf-dejavu-sans-mono fonts-conda-ecosystem
```

Set `CHROMIUM_ENV` if you put it somewhere else. The fonts are load-bearing:
without them `ch` units compute to zero and anything sized in them collapses to
a zero box, which reads exactly like a layout bug.

**Changing these tests.** Each one is a bug that shipped, so check a change
still fails for the right reason before trusting it. Reverting a fix should
turn exactly one test red with a message naming the cause. All five have been
checked that way:

| revert | expected failure |
|---|---|
| `@theme inline reference` to `@theme` | `bg-background resolved to nothing; theme tokens are inert` |
| our rules out of `@layer base` | `selected tab is transparent; our reset outranks our utilities` |
| `AnimatePresence root` | `wrapper measured 398px against a tallest pane of 210px` |
| the wrapper's pinned width | `measured wrapper changed width` |
| a second `OverlayProvider` | `more than one overlay host` |

Still true, and still what to reach for beyond the suite:

- `npm run build:pkg`, then building an app that consumes it, catches every
  import/JSX error.
- `curl` against the four endpoints above covers the whole server path.
- `curl 'http://localhost:5174/@fs/<abs-path>/src/styles.css?direct'` returns
  the *compiled* stylesheet. Read this before theorising about the cascade.
- The hub's browser drives `https://interpreter.hub.tailnet:<port>/` for
  anything exploratory; `dev/bubble.html` has the switches for it.
- **jsdom** settled the shadow-DOM retargeting question (`composedPath()`
  truncates on a *closed* root). Reach for it before theorising about DOM
  behaviour.
- Taste is still a human call. Correctness mostly isn't; check it.
