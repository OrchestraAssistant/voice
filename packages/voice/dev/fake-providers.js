// Dev-only fake providers for bubble.html?providers=multi.
//
// Two engines with DIFFERENT capabilities, so the engine picker and the
// capability-adaptive controls can be exercised with no relay, no keys and no
// network: one full-duplex "realtime" engine (warms, push-to-talk, barge-in)
// and one "on-device cascade" engine that can only do continuous + text. Both
// are real provider objects satisfying the contract (see PROVIDERS.md); their
// sessions just echo instead of talking to a model.
//
// Never shipped: `files` in package.json is dist/ only.

function fakeSession({ callbacks = {} }, { speaks }) {
  let mic = null;
  // A real provider reports readiness once its transport is up.
  callbacks.onStatus?.("ready");
  const echo = (text) => {
    callbacks.onTranscript?.({ role: "user", text });
    // Propose a tool call so onToolCall runs the real executor/gate in the core,
    // then (if the engine speaks) answer, so the transcript shows the round trip.
    callbacks.onToolCall?.("navigate", { path: "/" });
    if (speaks) callbacks.onTranscript?.({ role: "assistant", text: `heard: ${text}` });
  };
  return {
    stop() { callbacks.onStatus?.("closed"); },
    sendTextTurn: echo,
    attachMic: async () => (mic = {}),
    releaseMic: async () => { mic = null; },
    hasMic: () => !!mic,
    setMicEnabled() {},
    setTurnDetection() {},
    clearInputBuffer() {},
    commitAndRespond() {},
    cancelResponse() {},
  };
}

export function fakeProviders() {
  return [
    {
      label: "Realtime (fake)",
      provider: {
        // Reuse the realtime id so the relay's model/language options still show
        // under this engine, as they would for the real one.
        id: "openai-realtime",
        capabilities: { pushToTalk: true, bargeIn: true, textInput: true, warm: true },
        async mint() {
          return { key: "fake", expiresAt: Date.now() + 9 * 60_000, logging: false };
        },
        connect: (deps) => fakeSession(deps, { speaks: true }),
      },
    },
    {
      label: "On-device (fake cascade)",
      provider: {
        id: "moonshine-jev",
        // Only continuous + text: no held turn, no interrupting a reply, no warm.
        capabilities: { pushToTalk: false, bargeIn: false, textInput: true, warm: false },
        connect: (deps) => fakeSession(deps, { speaks: false }),
      },
    },
  ];
}
