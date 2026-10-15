# Providers — the voice-to-action contract

`@expert/voice` is a **core** (a React widget, a browser executor, a
confirmation gate, a manifest runtime) with a **swappable provider** for the
voice-to-action pipeline — the same shape the Vercel AI SDK has (`ai` core +
`@ai-sdk/openai` / `@ai-sdk/anthropic`). A provider adapts one realtime voice
API (OpenAI Realtime today) to the widget; the contract is how another one, such
as ElevenLabs Agents or Gemini Live, plugs in.

```
   voice in ──►  [ PROVIDER ]  ──► decided tool call ──►  [ EXECUTOR ]  ──► your app
                 (swappable)          onToolCall()          (core)        API + DOM
                      ▲                                          │
                      └──── transcripts / activity ────► [ UI ] (core)
```

A provider is everything between "audio in" and "a decided tool call." Nothing
else varies.

## What the core owns, always

These never move with the provider, and that is the point:

1. **The manifest** — the app as data, the single source of truth. A provider
   *reads* it; it does not define the app.
2. **The executor** — `executeTool` + transports + `domActions`. Tool calls run
   **in the browser**, against the app's own API (the user's cookies) and the
   live DOM. A provider never executes a tool; it only *proposes* one.
3. **The confirmation gate** — destructive actions stage in the executor and wait
   for a yes. A provider cannot bypass it.
4. **The UI** — `VoiceProvider` state, the rim, the panel — driven by callbacks.

## What a provider owns

1. A client **`VoiceSession`** — the transport and the live voice loop.
2. A server **half**, if it needs credentials — where keys live (see BYOK). For
   the OpenAI Realtime provider this is the relay (the `/voice` route); another
   realtime API needs its own equivalent, usually a token mint. **The relay is part of
   the OpenAI provider, not the framework.**

---

## The contract

A provider is a plain object (usually returned by a factory you configure):

```ts
type VoiceProviderFactory = (options?: object) => VoiceProviderSpec;

interface VoiceProviderSpec {
  id: string;                                   // "openai-realtime"
  capabilities: Capabilities;                   // what the UI may offer
  mint?(deps: ProviderDeps): Promise<Minted | null>;   // optional: pre-acquire a credential
  connect(deps: ProviderDeps): Promise<VoiceSession>;  // open the live session
}
```

`mint` is an optional optimisation: acquire a short-lived credential ahead of
time (the OpenAI provider mints an ephemeral key on hover) so the first "talk" is
fast. A provider with no credential omits it.

### `ProviderDeps` — what the core hands the provider

```ts
interface ProviderDeps {
  manifest: Manifest;            // the app as data
  toolCatalog: ToolCatalog;      // manifest projected to a neutral tool list (provided)
  callbacks: {
    onToolCall(name: string, args: object): Promise<Result>;  // THE contract — runs in the browser
    onTranscript(turn: { role: "user" | "assistant"; text: string }): void;
    onActivity(a: { userSpeaking: boolean; agentBusy: boolean }): void;
    onStatus(s: "connecting" | "ready" | "closed" | "error"): void;
    onHangUp(info: { because: string }): void;
    onEvent?(event: object): void;              // structured log stream, optional
  };
  initialMode: "continuous" | "ptt" | "ptnt";
  withMic: boolean;              // false = warm the connection without listening
  minted?: Minted | null;        // a handle from mint(), if any
  signal: AbortSignal;
}
```

`onToolCall` is the whole game: whenever the provider's model decides an action,
it calls this and awaits the result. That call lands in the core's executor —
which routes it to the manifest (`run_query`/`run_action`), the DOM (`dom_*`), or
the host router (`navigate`), enforces the confirmation gate, and returns a JSON
result the provider feeds back to its model. **A provider that can fire
`onToolCall` and stream `onTranscript`/`onActivity` is a complete provider.**

### `VoiceSession` — what `connect` returns

The live controls the UI drives. These are the least-common-denominator of a
voice session; a provider implements what it can and declares the rest absent via
`capabilities`.

```ts
interface VoiceSession {
  stop(): void;                       // tear down; nothing may speak after
  sendTextTurn(text: string): void;   // a typed turn (if capabilities.textInput)

  // microphone
  attachMic(): Promise<MediaStreamTrack>;
  releaseMic(): Promise<void>;        // release the mic, keep the connection
  hasMic(): boolean;
  setMicEnabled(enabled: boolean): void;   // mute / unmute

  // turn-taking (push-to-talk / push-to-not-talk)
  setTurnDetection(auto: boolean): void;   // server-VAD (true) vs manual (false)
  clearInputBuffer(): void;                // PTT press: begin a held turn
  commitAndRespond(): void;                // PTT release: finalise and answer

  // barge-in
  cancelResponse(): void;             // interrupt what the model is saying
}
```

The method names lean on the voice-session vocabulary, not any one vendor's wire
protocol; another realtime API implements `clearInputBuffer`/`commitAndRespond`
as "start/finish a held turn" over its own transport, `cancelResponse` as "stop
speaking and abort the in-flight response," and so on.

### `Capabilities` — so the UI adapts

```ts
interface Capabilities {
  pushToTalk: boolean;   // can it do manual turn-taking?
  bargeIn: boolean;      // can it be interrupted mid-response?
  textInput: boolean;    // does sendTextTurn do anything?
  warm: boolean;         // is mint()/pre-warm meaningful?
}
```

The core hides the controls a provider cannot honour (no push-to-talk button if
`pushToTalk` is false) instead of showing dead UI. A weaker provider degrades; it
does not break.

### `ToolCatalog` — the neutral projection

The core hands the provider the manifest already projected to a neutral list, so
a provider does not re-derive it:

```ts
type ToolCatalog = Array<{
  name: string;
  kind: "query" | "action";
  description: string;
  params: Param[];
  bodyFields?: Param[];
  destructive: boolean;   // from requiresConfirmation
  group?: string[];       // the topic, on a large app
}>;
```

Most providers re-project this into *their* model's tool format — OpenAI function
schemas, ElevenLabs client tools. The **manifest stays the
single source**; only the projection is provider-specific. (For the OpenAI
provider, that projection lives server-side in the relay, so the tool list the
model sees is authoritative and a tampered browser cannot redefine it.)

---

## BYOK — keys never touch the browser

One rule makes bring-your-own-key universal: **any call that needs a credential
goes through the provider's server half; the browser half is always keyless.**

- `provider.mint`/`connect` reach a server endpoint the app configures (the
  "broker"). That endpoint holds the key, reads it from its own environment, and
  returns only a short-lived handle.
- **OOTB:** the relay is the broker. BYOK means running it with *your*
  `OPENAI_API_KEY` (and, if exposed, a `VOICE_RELAY_SECRET` — see the README's
  "Securing the relay").
- **Another realtime API:** its server half mints that vendor's short-lived
  session token from *your* key. Your key, your infra. The rule holds for every
  provider: the key never reaches the page.

---

## Adding another realtime API

Implement the factory and hand it to the widget:

```jsx
import { VoiceProvider } from "@expert/voice";

const myProvider = () => ({
  id: "my-realtime",
  capabilities: { pushToTalk: true, bargeIn: true, textInput: true, warm: false },
  async connect({ toolCatalog, callbacks, withMic, signal }) {
    // 1. open the vendor's realtime session (WebRTC / WebSocket)
    // 2. project toolCatalog into the vendor's tool format
    // 3. when the model decides an action:
    //       const result = await callbacks.onToolCall(name, args);
    //       // feed result back to your model
    // 4. stream callbacks.onTranscript / onActivity / onStatus as they happen
    return {
      stop() { /* tear down */ },
      setMicEnabled(on) { /* mute */ },
      setTurnDetection(auto) { /* VAD vs PTT */ },
      clearInputBuffer() {}, commitAndRespond() {}, cancelResponse() {},
      attachMic: async () => {/*...*/}, releaseMic: async () => {}, hasMic: () => true,
      sendTextTurn(text) { /* a typed turn */ },
    };
  },
});

<VoiceProvider manifest={manifest} provider={myProvider()}> <Interpreter/> </VoiceProvider>
```

That is the whole surface. If your provider can fire `onToolCall` and stream
transcripts, the rim, the panel, the confirmation gate, navigation, and every
transport work unchanged — because none of them ever knew which provider they had.

---

## Offering a choice of engines

A provider is just an object, so a *list* of them is a list the user can pick
from — the same control surface as the model picker, one level up. Pass the
engines the app has wired; the widget shows them in Settings and the user
switches live:

```jsx
<VoiceProvider
  manifest={manifest}
  providers={[
    { label: "OpenAI Realtime", provider: openaiRealtime({ relayUrl }) },
    { label: "Other realtime",  provider: myRealtime() },  // see "Adding another realtime API"
  ]}
>
  <Interpreter/>
</VoiceProvider>
```

Three things make this well-behaved, and they are why it is a list of providers
and not a list of model strings:

- **The app offers, the user picks.** Each engine needs its own server half
  wired (a token mint for each realtime API), so the dev
  decides what is *available* — you cannot offer an engine you have not keyed.
  The user chooses among the available ones. (`providers` and the singular
  `provider` are the same prop at list length 0 and 1; omit both for the default
  single realtime engine.)
- **A switch is a reconnect, and the credential is dropped.** Unlike model or
  language — parameters to *one* engine — an engine is a whole implementation, so
  changing it tears the session down and builds the new one. A minted Realtime
  key means nothing to another vendor, so it is discarded on the switch.
- **The controls follow `capabilities`.** Switch to an engine that cannot
  push-to-talk and the PTT/PTNT modes disappear; switch to one with no relay
  model list and the Model/Language rows go with it. A weaker engine shows fewer
  controls, never dead ones.

A model is a string you pass to Realtime; an engine is the pipeline itself. So
the Realtime model/language pickers are *sub-options of that one engine*, shown
only while it is live.

---

## Packages

```
@expert/voice            core: the widget, the executor, the gate, the manifest
                         runtime, AND the client half of the provider
                         (openaiRealtime)
@expert/voice-cli        the manifest generator (build-time)
@expert/voice-server     the SERVER halves, as mountable Web handlers:
                           /openai  -> openaiVoiceHandler   (the realtime relay)
```

The split is by **side**, not by provider: client halves live in the core (so the
widget can default to realtime with no extra install), and the credentialed server
halves live in `@expert/voice-server` — a separate entry so server code and keys
never reach the browser bundle. A provider is still a pair that agree on one route;
the two halves just ship in these two packages.

### The server half: one route, mounted in the app

Every provider needs a server half that holds its keys; none of them need a
separate service. Mount the provider's handler at a route in the app's own
backend, and point the client half at the same path. The recipe is uniform:

```ts
// OpenAI Realtime — app/voice/[...path]/route.ts
import { openaiVoiceHandler } from "@expert/voice-server/openai";
const h = openaiVoiceHandler();            // OPENAI_API_KEY from env; serves /options,/session,/log
export const GET = h; export const POST = h;
//   client: <VoiceProvider relayUrl="" provider={openaiRealtime()}>   (same origin)
```

`toExpressHandler` adapts it for non-Web-standard backends. The handler is a
**mint**: one call per session, cheap on serverless. The audio then flows
between the browser and the vendor directly.

---

## Where voice is NOT the AI SDK (read this before designing a provider)

1. **Session, not call.** AI SDK providers are request/response over messages.
   A realtime voice provider is a **live, full-duplex, stateful session** — VAD,
   turn-taking, barge-in, audio in *and* out. Hence `connect() → VoiceSession`
   rather than `doStream(messages)`. AI SDK's speech/transcription are one-shot;
   there is no standard provider interface for full-duplex realtime voice — this
   is it.
2. **Tool execution is local and fixed.** The provider proposes tool calls via
   `onToolCall`; the *core* executes them in the browser (cookies + DOM). A
   **server-side** realtime agent must therefore **bridge** its model's tool
   calls down to the browser and the result back up. Prefer realtime APIs that
   support client-side tools, where `onToolCall` fires in the page.
3. **Safety is the core's, not the provider's.** The confirmation gate lives in
   the executor, so a custom provider can only ever *propose* a destructive
   action; the core stages and confirms it.

---

## Status

- **Shipped:** the contract; the **`openaiRealtime`** provider; the core
  `VoiceProvider` routed through the contract as its single path (`warm`,
  `connect` and `mint` all go through the active provider, and a live **engine
  picker** switches among several, with capability-adaptive controls driven
  in-browser by `test/providers-ui.test.mjs`); and **`@expert/voice-server`**,
  the mountable server half, so a host owns the backend as one route in its own
  app.
- **Next:** adapters for other realtime voice APIs that support client-side
  tools.
