# Adding voice control to this app — agent guide

You are an agent helping a developer add voice control to their web app using
**@expert/voice**. Static analysis turns the app's source into a *manifest* of
what it can do; a widget in the browser listens, and runs what the voice engine
decides (a page, a query, an action, a click) in the app, with the user's own
session. Your job is to install the packages, build a good manifest, wire the
widget, and mount **one small route in the app's own server** that holds the
app's key.

The engine is **Orchestra** (the default): a hosted service. The app registers
with Orchestra and gets a secret key; the route trades it for short-lived
session tokens for the page, so the key never reaches a browser. The
alternative is OpenAI Realtime on the app's own OpenAI key (step 4 has both).

This page is self-contained: start here with nothing installed. Not on npm yet:
the three packages install from the GitHub release (pre-built, so the host needs
no build step or Tailwind). Do the steps in order — each is a real command you
run in the app's repo.

## 1. Install the packages

Skip this step if `node_modules/@expert/voice-cli` already exists.

```
REL=https://github.com/OrchestraAssistant/voice/releases/download/v0.1.6
npm install    $REL/expert-voice-0.1.6.tgz          # the widget (runtime)
npm install -D $REL/expert-voice-cli-0.1.6.tgz      # the CLI (build-time tooling)
npm install    $REL/expert-voice-server-0.1.6.tgz   # the backend route (runtime)
```

If the frontend and backend are separate packages, the widget goes in the
frontend and `@expert/voice-server` in the backend. With yarn: `yarn add <url>`
and `yarn add -D <url>`. Their public dependencies resolve from the normal
registry; only these three come from the URL.

## 2. Get the skill's procedure and follow it in this session

The **`expert-voice`** skill IS the detailed workflow. Read it and follow it
NOW — do not wait for skill discovery or a restart:

```
npx voice-skill --print      # prints the full procedure, matching the installed version
# optional, for future sessions:  npx voice-skill   (installs it into .claude/skills)
```

The skill's stage 0 (install) is already done by step 1 above; start at stage 1.

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

**First ask the developer** whether they want the standalone widget (one line,
works today, the fastest way to try it) or a custom UI that matches the app's
design or a UX constraint (a command bar the app already has, no floating
button, and so on). Do not choose for them. The skill's "Ask the developer"
section has the wording and, for the custom path, what a custom UI must still
provide: a listening indicator, confirmations, start/stop, errors. The
provider, the manifest and the route below are the same either way. What
follows is the standalone path.

Mount the provider once, inside the app's router, pass it the generated
manifest, and give it a navigate function. With no `provider` prop it uses
Orchestra, and asks the app's own `/voice/token` (the route you mount in step 4)
for its sessions; leave `relayUrl` unset (same origin).

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
  // The engine defaults to Orchestra: the page asks this app's /voice/token (step 4).
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

The engine needs a **server half** that holds the key — the browser never gets
it. You do not run a separate service: you **mount one route in this same app**,
from `@expert/voice-server` (installed in step 1).

### Orchestra (the default)

You need two values, which the developer gets when the app is registered with
Orchestra: **`ORCHESTRA_KEY`** (the app's secret key) and **`ORCHESTRA_URL`**
(the service). Registration also lists the origins the app's pages are served
from (e.g. `https://app.example.com`, `http://localhost:3000`); the service
refuses pages from any other origin. **If the developer does not have them yet,
ask them for the key, the URL, and to register the origins you will test from;
do not switch to OpenAI on your own.** Put both in the server's env (never in
frontend code, never committed).

Mount the token route at `/voice/token`:

```ts
// app/voice/token/route.ts   (Next.js App Router)
import { orchestraTokenHandler } from "@expert/voice-server/orchestra";
export const POST = orchestraTokenHandler({ trustAuth: true }); // see "Guard the route"
```

(Express: `app.post("/voice/token", express.json(), toExpressHandler(orchestraTokenHandler({ trustAuth: true })))`,
with `toExpressHandler` from the same import.)

That is the whole server half. The page gets a token from it, learns the
service's address from it, and talks to Orchestra directly from then on; it
renews the token itself.

**Guard the route.** Whoever can call `/voice/token` can use voice on the app's
Orchestra account, within its limits. Pick one:

- The route already sits behind the app's login → `{ trustAuth: true }`.
- Otherwise → `{ requireAuth: (req) => isLoggedIn(req) }` (false answers 401),
  or `{ secret: process.env.VOICE_SECRET }` that the app's own backend injects as
  `Authorization: Bearer …` — never a secret shipped to the page.

A per-IP rate limit (30/min) is on by default (`rateLimit: false` disables it).
With no guard configured the handler warns once at startup.

**If the app sends a Content-Security-Policy**, its `connect-src` must allow
`ORCHESTRA_URL` and `wss://api.elevenlabs.io` (live transcription streams from
the page), and its `media-src` must allow `blob:` (the few spoken lines).

How to tell what's wrong: `curl -X POST localhost:<port>/voice/token -H
'content-type: application/json' -d '{}'` returns `{ token, url, ... }` when it
works; `500: ORCHESTRA_URL and ORCHESTRA_KEY must be set` means the env is
missing; `Orchestra refused this app's key` means the key is wrong; a widget
error naming `/voice/token` means the route is not mounted; a CORS error in the
browser console naming the Orchestra URL means the page's origin is not
registered yet (ask the developer to add it).

### OpenAI Realtime (the alternative)

Only if the developer chooses it. Pass `provider={openaiRealtime()}` to
`VoiceProvider` (import it from `@expert/voice`), set `OPENAI_API_KEY` in the
server's env, and mount the relay at `/voice`; it serves `GET /options`,
`POST /session`, `POST /log`:

```ts
// app/voice/[...path]/route.ts   (Next.js App Router)
import { openaiVoiceHandler } from "@expert/voice-server/openai";
const handler = openaiVoiceHandler({ trustAuth: true }); // guard it as above
export const GET = handler;
export const POST = handler;
```

(Express: `app.use("/voice", express.json(), toExpressHandler(openaiVoiceHandler({ trustAuth: true })))`.)
`/voice/session` mints tokens billed to the app's own OpenAI key, so guard it
the same way. No key → `500: OPENAI_API_KEY is not set on the server.`

The full provider contract (plugging in another engine) is **PROVIDERS.md**,
which ships inside `@expert/voice` (`node_modules/@expert/voice/PROVIDERS.md`)
and is in the [voice repo](https://github.com/OrchestraAssistant/voice/blob/main/PROVIDERS.md).

## Dev-server and HTTPS notes

- If the frontend dev server and the API run on different ports, proxy `/voice`
  to the backend (Vite: `server: { proxy: { "/voice": "http://localhost:<api-port>" } }`).
- The microphone needs HTTPS or `localhost`, and an HTTPS page cannot call an
  `http://` backend (mixed content), so keep `/voice` same-origin.
- Orchestra checks the page's origin: the dev server's origin
  (`http://localhost:<port>`) must be registered too, or the browser reports a
  CORS error.

## What "done" looks like

- `.voice/manifest.json` + `.voice/manifest.overlay.json` exist, and the flagged
  operations have real descriptions and group tiers.
- The provider is mounted, and the token route (step 4) is served by this app
  with its key in env — `curl -X POST localhost:<port>/voice/token -H
  'content-type: application/json' -d '{}'` returns a token and a url (for
  OpenAI Realtime: `curl localhost:<port>/voice/options` returns a model list).
- A voice session (driven by a human with a microphone) can navigate the app and
  run its operations by voice. In a headless container you can verify everything
  up to that last step — the manifest and the wiring — without a live call.

If anything is unclear, the `expert-voice` skill is the source of truth for the
workflow; this page is only the front door.
