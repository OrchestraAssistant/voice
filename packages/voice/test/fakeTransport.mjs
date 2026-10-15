/**
 * A realtime session with no network, no WebRTC and no microphone.
 *
 * Everything that decides how a session behaves used to be unreachable from a
 * test: it lived in a closure over a live connection, so the only thing a test
 * could do was assert that the source code READ a certain way. That is a weak
 * check twice over -- it breaks on refactors that change nothing, and it
 * passes when behaviour is wrong but the text is right.
 *
 * With this, a test says what the server sent and asserts what the client sent
 * back. Which is the actual contract.
 */
export function fakeTransport({ micAvailable = true } = {}) {
  const listeners = new Map();
  const sent = [];
  let mic = null;
  let opened = false;

  const fire = (type, event) => (listeners.get(type) ?? []).forEach((fn) => fn(event));

  const transport = {
    channel: {
      send: (payload) => sent.push(JSON.parse(payload)),
      addEventListener: (type, fn) => {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
        // A real channel that is already open never fires `open` again, and
        // the client subscribes AFTER taking the microphone -- so a fake that
        // only fires forward leaves any session with a mic waiting forever.
        if (type === "open" && opened) fn({});
      },
      close: () => fire("close", {}),
    },

    async attachMic() {
      if (!micAvailable) throw new Error("Permission denied");
      mic = { enabled: true };
      return mic;
    },
    async releaseMic() {
      if (!mic) return false;
      mic = null;
      return true;
    },
    hasMic: () => !!mic,
    setMicEnabled: (enabled) => mic && (mic.enabled = enabled),
    async connect() {},
    close: () => (mic = null),

    // --- the test's side ---

    /** Everything the client has sent, in order. */
    sent,
    /** Only the messages of one type, which is what most assertions want. */
    ofType: (type) => sent.filter((m) => m.type === type),
    /** The channel is open; the client treats this as "ready". */
    open: () => {
      opened = true;
      fire("open", {});
    },
    /** One server event. */
    server(message) {
      fire("message", { data: JSON.stringify(message) });
    },
    /** Several, in order, awaiting between so async handlers settle. */
    async play(messages) {
      for (const message of messages) {
        transport.server(message);
        await new Promise((r) => setTimeout(r, 0));
      }
    },
    micEnabled: () => mic?.enabled,
  };
  return transport;
}

/** A minted key that is valid, so no relay is contacted. */
export const mintedKey = () => ({ key: "test-key", expiresAt: Date.now() + 9 * 60_000, logId: "test", logging: false });

/** Opens a session against a fake transport and returns both halves. */
export async function fakeSession(overrides = {}) {
  const { connectRealtimeSession } = await import("../src/realtimeClient.js");
  const transport = overrides.transport ?? fakeTransport();
  const events = [];
  const transcript = [];

  const ready = connectRealtimeSession({
    minted: mintedKey(),
    withMic: false,
    openTransport: () => transport,
    onEvent: (e) => events.push(e),
    onTranscript: (t) => transcript.push(t),
    onStatus: () => {},
    onToolCall: async () => ({ ok: true }),
    ...overrides,
  });
  // The connect promise resolves when the channel OPENS, which on a real
  // connection is the server's doing.
  transport.open();
  const session = await ready;
  return { session, transport, events, transcript };
}

/** A response.done carrying one function call. */
export const toolCall = (name, args = {}, callId = "call-1") => ({
  type: "response.done",
  response: {
    status: "completed",
    output: [{ type: "function_call", name, call_id: callId, arguments: JSON.stringify(args) }],
    usage: { input_tokens: 100, output_tokens: 10 },
  },
});

/** A response.done carrying a spoken or written reply. */
export const reply = (text, modalities = ["text"]) => ({
  type: "response.done",
  response: {
    status: "completed",
    output: [{ type: "message", content: [{ type: "text", text }] }],
    output_modalities: modalities,
    usage: { input_tokens: 100, output_tokens: 20 },
  },
});
