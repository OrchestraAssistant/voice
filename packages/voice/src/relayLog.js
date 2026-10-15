/**
 * Ships session events to the relay, so a run can be read back afterwards.
 *
 * This lives in the widget rather than in the host app on purpose. The relay
 * is not in the data path -- it mints a token and steps out, and the
 * conversation goes browser to OpenAI directly -- so the server cannot observe
 * a session on its own, and something has to post. Making that the host's job
 * would mean every customer wiring up callbacks to get logs of their own
 * product; both ends of this are ours, so we do it.
 *
 * OFF by default, at both ends: the widget needs `logToRelay` and the relay
 * needs VOICE_LOG=1. This is a recording of what people said out loud, and
 * that is not something to switch on by inference.
 *
 * Batched because a single turn produces a handful of events and one request
 * per event would be silly; flushed on a timer and again on unload, where
 * sendBeacon survives the page going away and fetch does not.
 */
export function createRelayLogger({ relayUrl = "", flushMs = 2000 } = {}) {
  let logId = null;
  let queue = [];
  let timer = null;

  const url = `${relayUrl}/voice/log`;

  function flush({ beacon = false } = {}) {
    if (!logId || queue.length === 0) return;
    const body = JSON.stringify({ logId, events: queue });
    queue = [];
    if (beacon && typeof navigator !== "undefined" && navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
      return;
    }
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {
      // Logging must never break a session. A dropped batch is a dropped batch.
    });
  }

  const onUnload = () => flush({ beacon: true });
  if (typeof window !== "undefined") window.addEventListener("pagehide", onUnload);

  return {
    /** Feed this to connectRealtimeSession's onEvent. */
    record(event) {
      // The relay hands out the log handle when it mints the session, so a
      // transcript can be tied back to the model and language that produced it.
      if (event.type === "connected") {
        logId = event.logging ? event.logId : null;
        if (!logId) return;
      }
      if (!logId) return;
      // Stamped HERE, when it happened, not when the batch lands. Events are
      // held for `flushMs` and the relay times them on arrival, so without
      // this a whole turn arrives sharing one timestamp -- which made a real
      // session look like four rim states inside a millisecond, and made the
      // log useless for the one question it is kept for: what happened, in
      // what order, and how far apart. An event that carries its own `at`
      // keeps it.
      queue.push({ at: new Date().toISOString(), ...event });
      if (!timer) timer = setTimeout(() => { timer = null; flush(); }, flushMs);
    },
    stop() {
      flush();
      if (typeof window !== "undefined") window.removeEventListener("pagehide", onUnload);
      if (timer) clearTimeout(timer);
    },
  };
}
