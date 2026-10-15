# Adding voice control to this app — agent guide

You are an agent helping a developer add voice control to their web app using
**@expert/voice**. Static analysis turns the app's source into a *manifest* of
what it can do; a small **route in the app itself** mints realtime-voice sessions
from that manifest (holding the OpenAI key server-side); a widget in the browser
executes the calls. Your job is to install the packages, build a good manifest,
and mount that route. There is no separate service to point at — the backend is
one endpoint in this app.

Not on npm yet: the three packages install from the GitHub release (pre-built,
so the host needs no build step or Tailwind). Do the steps in order — each is a
real command you run in the app's repo.

## 1. Install the packages

```
REL=https://github.com/OrchestraAssistant/voice/releases/download/v0.1.4
npm install    $REL/expert-voice-0.1.4.tgz          # the widget (runtime)
npm install -D $REL/expert-voice-cli-0.1.4.tgz      # the CLI (build-time tooling)
npm install    $REL/expert-voice-server-0.1.4.tgz   # the backend route (runtime)
```

If the frontend and backend are separate packages, the widget goes in the
frontend and `@expert/voice-server` in the backend. With yarn: `yarn add <url>`
and `yarn add -D <url>`. Their public dependencies resolve from the normal
registry; only these three come from the URL.

## 2. Get the skill's procedure and follow it in this session

The **`expert-voice`** skill IS the detailed workflow. Read it and follow it
NOW — do not wait for skill discovery or a restart:

```
npx voice-skill --print      # prints the full procedure; read it and do it
# optional, for future sessions:  npx voice-skill   (installs it into .claude/skills)
```

In outline, so you know where you are going:

- `npx voice-cli` → writes `.voice/manifest.json` (static analysis).
- `npx voice-probe .voice/manifest.json <running-app-url> --login spec.json --browser`
  → confirms routes, measures page readiness, checks what writes require.
  `--browser` drives Chrome through `puppeteer-core`, which is not bundled:
  `npm install -D puppeteer-core` first. If the browser fails to launch, see
  [browser-setup.md](browser-setup.md). Without a browser the probe skips only
  readiness; everything else still runs.
- The **judgement pass**: resolve the operations the manifest flagged
  (`review` / `confidence` / empty `bodyFields`) into real descriptions and
  tiers, written to `.voice/manifest.overlay.json`, confirmed by the read-back
  probe. The skill has the loop and a worked example.

Do not skip to step 3 until the manifest reads like a person wrote it — the
quality of the voice experience is the quality of the manifest.

Add `npx voice-cli src .voice --check` to the app's CI: it exits non-zero when
the committed manifest no longer matches the code.

## 3. Wire the widget

Mount the provider once, inside the app's router, pass it the generated
manifest, and give it a navigate function. Leave `relayUrl` unset (it defaults
to same-origin `""`), so the widget talks to the backend route you mount in
step 4.

`VoiceProvider` is only the plumbing (context + an overlay host). The VISIBLE
widget — the floating button and rim — is a separate component,
**`<Interpreter/>`**, which you render INSIDE the provider. Both are needed, or
nothing appears on screen:

```jsx
import { VoiceProvider, Interpreter } from "@expert/voice";
import manifest from "./.voice/manifest.json";

<VoiceProvider
  manifest={manifest}
  navigate={(path) => router.push(path)}
  // relayUrl defaults to "" = same origin -> the /voice route you mount in step 4.
  // Refresh the app's data after a voice write, or the change only shows on reload.
  // Wire this to THIS app's own cache invalidation -- see below.
  onAfterAction={refreshMyAppsData}
>
  <Interpreter />        {/* ← this is what you see; without it there is no widget */}
  {children}
</VoiceProvider>
```

Do not import a stylesheet: the widget renders into its own shadow root and
injects its CSS there.

Do not skip `onAfterAction`: a voice write hits the API out-of-band, so the
app's cache does not know and the UI sits stale until a reload (the classic "it
only showed after I refreshed"). The pattern is always the same -- *after a
write, tell your data layer the data changed* -- but the exact call is whatever
THIS app's data layer uses. Examples for common libraries:

- react-query: `() => queryClient.invalidateQueries()`
- tRPC: `() => utils.invalidate()`
- SWR: `() => mutate(() => true)`
- Next.js app router (server components): `() => router.refresh()`
- Apollo: `() => client.refetchQueries({ include: "active" })`

Figure out which data layer this app uses (look at how its own mutations refresh
the UI after they succeed) and wire the equivalent. It is passed the action name
if you want to be surgical: `onAfterAction={({ name }) => ...}`. Without it, the
widget synthesises a focus event as a best-effort fallback, which most
react-query/SWR apps refetch on.

(The split is deliberate — a host that wants to build its own UI can call
`useInterpreter()` instead of rendering `<Interpreter/>` — but the default path
is to render it.)

## 4. Serve the backend route (required)

The voice engine needs a **server half** that holds the keys — the browser never
gets them. You do not run a separate service: you **mount one route in this same
app**, served by `@expert/voice-server` (installed in step 1). The recipe is the
same whatever the engine:

> **set the keys in env → mount the provider's handler at `/voice` → the widget
> (same-origin, step 3) calls it.**

**OpenAI Realtime (the default engine).** The handler serves the whole `/voice`
surface (`GET /options`, `POST /session`, `POST /log`) and mints with the app's
own `OPENAI_API_KEY` — set that in the app's server env first:

```ts
// app/voice/[...path]/route.ts   (Next.js App Router)
import { openaiVoiceHandler } from "@expert/voice-server/openai";
const handler = openaiVoiceHandler({ trustAuth: true }); // see "Guard the route"
export const GET = handler;
export const POST = handler;
```

(Express: `app.use("/voice", express.json(), toExpressHandler(openaiVoiceHandler({ trustAuth: true })))`,
with `toExpressHandler` from the same import.)

**Guard the route.** `/voice/session` mints tokens billed to the app's key, so
an unauthenticated public route is an open, billable proxy. Pick one:

- The route already sits behind the app's login → `{ trustAuth: true }`.
- Otherwise → `{ requireAuth: (req) => isLoggedIn(req) }` (false answers 401
  before minting), or `{ secret: process.env.VOICE_SECRET }` that the app's own
  backend injects as `Authorization: Bearer …` — never a secret shipped to the
  page.

A per-IP rate limit (30/min) is on by default (`rateLimit: false` disables it).
With no guard configured the handler warns once at startup.

How to tell what's wrong: no key in the env → `/voice/session` returns
`500: OPENAI_API_KEY is not set on the server.`; no route mounted → the widget
reports `Could not reach the voice relay at … Is it running?` (or `answered 404
with no JSON`). Both mean the route above is not mounted-and-keyed yet.

**Alternative: a JEV cascade (browser-local Moonshine STT + JEV + a text model).**
Mount the broker instead, which holds the JEV key and your text-model key:

```ts
// app/voice/[...path]/route.ts
import { jevBrokerHandler, openaiText } from "@expert/voice-server/jev";
export const POST = jevBrokerHandler({ generate: openaiText() }); // JEV_API_KEY + OPENAI_API_KEY from env
```

Moonshine runs the speech model IN THE BROWSER via transformers.js, which is a
heavy optional dependency the core does NOT bundle — so you install it in the app
and hand it to `moonshineStt` as `loadTransformers`. Skip this and the widget
reports `moonshineStt needs { loadTransformers: ... }` and does nothing:

```
npm install @huggingface/transformers
```

```jsx
// the client half: STT runs in the browser, keys stay on the route above
import { VoiceProvider, Interpreter, moonshineJev, moonshineStt, jevBroker } from "@expert/voice";

const stt = moonshineStt({
  loadTransformers: () => import("@huggingface/transformers"), // REQUIRED — you install this dep
  size: "base",                                                // or "tiny" for the wasm fallback
});

<VoiceProvider manifest={manifest} navigate={(p) => router.push(p)}
  provider={moonshineJev({ stt, ...jevBroker("") })}>
  <Interpreter />
</VoiceProvider>
```

(Moonshine needs WebGPU or a WASM fallback; `size: "base"` is accurate on WebGPU,
`"tiny"` is lighter for WASM. The broker above is the only server piece.)

Offer several engines at once by passing `providers={[{label, provider}, …]}`
instead of one — the user picks in Settings. The full contract (every provider's
deps, the BYOK rule, writing your own) is **PROVIDERS.md**, which ships inside
`@expert/voice` (`node_modules/@expert/voice/PROVIDERS.md`) and is in the
[voice repo](https://github.com/OrchestraAssistant/voice/blob/main/PROVIDERS.md).

## Dev-server and HTTPS notes

- If the frontend dev server and the API run on different ports, proxy `/voice`
  to the backend (Vite: `server: { proxy: { "/voice": "http://localhost:<api-port>" } }`).
- The microphone needs HTTPS or `localhost`, and an HTTPS page cannot call an
  `http://` backend (mixed content), so keep `/voice` same-origin.

## What "done" looks like

- `.voice/manifest.json` + `.voice/manifest.overlay.json` exist, and the flagged
  operations have real descriptions and group tiers.
- The provider is mounted, and the `/voice` route (step 4) is served by this app
  with its key in env — `curl localhost:<port>/voice/options` returns a model list.
- A voice session (driven by a human with a microphone) can navigate the app and
  run its operations by voice. In a headless container you can verify everything
  up to that last step — the manifest and the wiring — without a live call.

If anything is unclear, the `expert-voice` skill is the source of truth for the
workflow; this page is only the front door.
