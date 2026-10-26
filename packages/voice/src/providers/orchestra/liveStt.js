/**
 * Speech-to-text while the user speaks: a realtime transcriber (ElevenLabs
 * Scribe v2 Realtime), straight from the page over a WebSocket. The mic is
 * cut into turns (micTurns: an energy VAD, or push-to-talk), and each frame
 * goes out as it is captured, so when the turn ends the words are already
 * transcribed and only the commit is left: a round trip, not an upload and a
 * whole transcription.
 *
 * No key is in the page: it asks the service's /stt-token for a single-use
 * token per connection. Only speech is sent: the socket hears nothing between
 * turns.
 *
 * Keyterms (names on screen and in the app's records) are fixed when a
 * connection opens, so a changed list reconnects while nobody is speaking.
 *
 * Whenever the live path fails -- no key on the server, the socket closed, no
 * transcript in time -- the turn goes to /transcribe as a clip instead (clipStt).
 * A turn is slower then, never lost.
 */
import { micTurns, base64Of } from "./micTurns.js";
import { clipStt } from "./clipStt.js";

export const ELEVENLABS_REALTIME = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";

/** Float samples -> 16-bit little-endian PCM, base64: what an input_audio_chunk carries. */
export function pcm16Base64(samples) {
  const out = new DataView(new ArrayBuffer(samples.length * 2));
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out.setInt16(i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return base64Of(new Uint8Array(out.buffer));
}

/**
 * Keyterms as Scribe Realtime takes them: at most 50, each at most 20
 * characters. One over either limit refuses the whole connection
 * (invalid_request), so the rest are dropped here: a long task title is no
 * keyterm, its turn is still live.
 */
export const realtimeKeyterms = (terms) => [...new Set((terms ?? []).map((t) => String(t).trim()).filter((t) => t && t.length <= 20))].slice(0, 50);

/** The realtime URL for one connection: manual commits (our VAD ends the turn), the token, the keyterms. */
export function realtimeUrl({ token, sampleRate = 16000, language, keyterms = [], url = ELEVENLABS_REALTIME }) {
  const q = new URLSearchParams({ model_id: "scribe_v2_realtime", token, audio_format: `pcm_${sampleRate}`, commit_strategy: "manual" });
  if (language) q.set("language_code", language);
  for (const t of realtimeKeyterms(keyterms)) q.append("keyterms", t);
  return `${url}?${q}`;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]   prefix for /voice/stt-token and /voice/transcribe ("" = as given to fetchImpl)
 * @param {string} [opts.language]  ISO-639-1, e.g. "en"
 * @param {number} [opts.commitTimeoutMs]  how long to wait for the transcript after the turn ends
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {typeof WebSocket} [opts.WebSocketImpl]
 * @param {(event: object) => void} [opts.onEvent]  what happened per turn (live, fallback, ms), for logs
 * and micTurns' silenceMs, threshold, maxTurnMs.
 */
export function liveStt({ baseUrl = "", language, commitTimeoutMs = 2500, fetchImpl, WebSocketImpl, onEvent, ...turnOptions } = {}) {
  const doFetch = fetchImpl ?? ((...a) => fetch(...a));
  const Socket = WebSocketImpl ?? globalThis.WebSocket;
  const sampleRate = turnOptions.sampleRate ?? 16000;
  const batch = clipStt({ baseUrl, language, fetchImpl: doFetch, sampleRate });
  let keyterms = [];
  let conn = null; // { ws, open: Promise<boolean>, terms, waiting, closed }
  let unavailable = false; // the server has no live transcriber: stop asking
  let inTurn = false;
  let sent = 0; // frames of this turn that reached the socket
  let usage = { seconds: 0 }; // audio sent since the last takeUsage(): the service prices it

  function connect() {
    const terms = keyterms.join("\n");
    const c = { ws: null, terms, waiting: null, closed: false };
    c.open = (async () => {
      const r = await doFetch(`${baseUrl}/voice/stt-token`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (r.status === 404 || r.status === 501) unavailable = true;
      if (!r.ok) throw new Error(`/voice/stt-token HTTP ${r.status}`);
      const { token, url } = await r.json();
      const ws = new Socket(realtimeUrl({ token, sampleRate, language, keyterms, url }));
      c.ws = ws;
      return await new Promise((resolve, reject) => {
        ws.onmessage = (e) => {
          let m;
          try { m = JSON.parse(e.data); } catch { return; }
          if (m.message_type === "session_started") return resolve(true);
          if (m.message_type === "partial_transcript") { if (c.waiting) c.waiting.partial = m.text ?? ""; return; }
          if (m.message_type === "committed_transcript") return c.waiting?.done(m.text ?? "");
          if (m.error || /error|exceeded|limited|overflow|exhausted|throttled|terms/.test(m.message_type ?? "")) {
            reject(new Error(m.error ?? m.message_type));
            c.waiting?.fail(new Error(m.error ?? m.message_type));
          }
        };
        ws.onerror = () => reject(new Error("live transcriber socket error"));
        ws.onclose = () => {
          c.closed = true;
          if (conn === c) conn = null;
          reject(new Error("live transcriber closed"));
          c.waiting?.fail(new Error("live transcriber closed"));
        };
      });
    })();
    c.open.catch(() => { c.closed = true; if (conn === c) conn = null; });
    return c;
  }

  const close = (c) => { c.closed = true; try { c.ws?.close(); } catch { /* already gone */ } };
  /** The connection to use now: a fresh one when there is none, or its keyterms are stale. */
  function current() {
    if (unavailable) return null;
    if (conn && !conn.closed && conn.terms === keyterms.join("\n")) return conn;
    if (conn) close(conn);
    conn = connect();
    return conn;
  }

  // Frames go out in order; a frame captured while the socket opens waits for it.
  let chain = Promise.resolve();
  const send = (c, audio, commit = false) => {
    chain = chain.then(async () => {
      if (!(await c.open.catch(() => false)) || c.closed) return false;
      c.ws.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: audio, commit, sample_rate: sampleRate }));
      usage.seconds += (audio.length * 3) / 4 / 2 / sampleRate; // base64 -> 16-bit samples
      return true;
    });
    return chain;
  };

  let turnConn = null;
  function onFrame(frame) {
    if (!inTurn) { inTurn = true; sent = 0; turnConn = current(); }
    if (turnConn) send(turnConn, pcm16Base64(frame)).then((ok) => { if (ok) sent++; });
  }

  /** The end of a turn: commit what was streamed and wait for its text; else transcribe the clip. */
  async function onTurn(samples) {
    const c = turnConn;
    const frames = Math.ceil(samples.length / 4096);
    inTurn = false;
    turnConn = null;
    const t0 = Date.now();
    if (c && !c.closed) {
      try {
        const text = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => (c.waiting?.partial ? resolve(c.waiting.partial) : reject(new Error("no transcript in time"))), commitTimeoutMs);
          c.waiting = { partial: "", done: (t) => { clearTimeout(timer); resolve(t); }, fail: (e) => { clearTimeout(timer); reject(e); } };
          // 100 ms of silence carries the commit: a chunk must have audio in it.
          send(c, pcm16Base64(new Float32Array(sampleRate / 10)), true).then((ok) => {
            if (!ok) c.waiting?.fail(new Error("live transcriber not open"));
          });
        });
        // Every frame must have reached the socket, or the text is missing a start.
        if (sent >= frames - 1) {
          onEvent?.({ stt: "live", commitMs: Date.now() - t0 });
          return text;
        }
        throw new Error(`only ${sent} of ${frames} frames were streamed`);
      } catch (err) {
        onEvent?.({ stt: "fallback", because: String(err.message ?? err) });
      } finally {
        c.waiting = null;
      }
    }
    const text = await batch.transcribe(samples);
    usage.seconds += batch.takeUsage().seconds;
    onEvent?.({ stt: "batch", ms: Date.now() - t0 });
    return text;
  }

  const mic = micTurns({ ...turnOptions, sampleRate, onFrame, onTurn });
  return {
    ...mic,
    async start(h = {}) {
      await mic.start(h);
      // Open before the first turn, so it does not wait for a token and a
      // handshake; after the host's first keyterms, which would reopen it.
      setTimeout(() => { if (!conn && !inTurn) current(); }, 1500);
    },
    stop() {
      mic.stop();
      if (conn) close(conn);
      conn = null;
    },
    transcribe: onTurn,
    /** Seconds of audio transcribed since the last call: a turn's share. */
    takeUsage() {
      const u = usage;
      usage = { seconds: 0 };
      return u;
    },
    /** One frame of a turn, as the mic would give it: for tests, or audio from elsewhere. */
    feed: onFrame,
    /** Names to expect. A changed list takes a new connection, opened now if nobody is speaking. */
    setKeyterms(list) {
      batch.setKeyterms(list); // a clip transcriber takes long ones too
      const next = realtimeKeyterms(list);
      if (next.join("\n") === keyterms.join("\n")) return;
      keyterms = next;
      if (!inTurn && !conn?.waiting) current(); // else the next turn reopens it
    },
  };
}
