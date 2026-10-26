/**
 * Speech-to-text a turn at a time, and the spoken reply, through the service:
 * the mic is cut into turns in the page (micTurns), each turn goes to
 * POST /voice/transcribe as a WAV, and a reply line comes back from
 * POST /voice/speak as audio. orchestra() routes both to the hosted service
 * with the session's token (its `fetch`).
 *
 * clipStt is the fallback for liveStt (whenever the live path fails) and the
 * transcriber when live transcription is off.
 */
import { micTurns, wavOf, base64Of } from "./micTurns.js";

const post = (doFetch, url, payload) =>
  doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });

/**
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]   prefix for /voice/transcribe ("" = as given to fetchImpl)
 * @param {string} [opts.language]  ISO-639-1, e.g. "en"; detected if omitted
 * @param {typeof fetch} [opts.fetchImpl]
 * and micTurns' silenceMs, threshold, maxTurnMs.
 */
export function clipStt({ baseUrl = "", language, fetchImpl, ...turnOptions } = {}) {
  const doFetch = fetchImpl ?? ((...a) => fetch(...a));
  const sampleRate = turnOptions.sampleRate ?? 16000;
  let keyterms = [];
  let seconds = 0; // since the last takeUsage()

  /** One turn's audio -> its text. */
  async function transcribe(samples) {
    const r = await post(doFetch, `${baseUrl}/voice/transcribe`, {
      audio: base64Of(wavOf(samples, sampleRate)),
      format: "wav",
      ...(language && { language }),
      ...(keyterms.length && { keyterms }),
    });
    if (!r.ok) throw new Error(`/voice/transcribe HTTP ${r.status}`);
    const out = await r.json();
    seconds += out.seconds ?? samples.length / sampleRate;
    return out.text ?? "";
  }

  const mic = micTurns({ ...turnOptions, sampleRate, onTurn: transcribe });
  return {
    ...mic,
    transcribe,
    /** Seconds of audio transcribed since the last call. */
    takeUsage() {
      const u = { seconds };
      seconds = 0;
      return u;
    },
    /** Names to expect in the next turns: what is on screen, the app's records. */
    setKeyterms(list) { keyterms = [...new Set((list ?? []).filter(Boolean))].slice(0, 100); },
  };
}

/**
 * The spoken reply: speak(text) plays the line, cancel() stops it (barge-in).
 * BROWSER ONLY (an <audio> element).
 */
export function speaker({ baseUrl = "", fetchImpl } = {}) {
  const doFetch = fetchImpl ?? ((...a) => fetch(...a));
  let playing = null;
  const stop = () => {
    if (!playing) return;
    playing.audio.pause();
    URL.revokeObjectURL(playing.url);
    playing.done();
    playing = null;
  };
  return {
    /** Plays the line; `onStart` when the sound starts. */
    async speak(text, { onStart } = {}) {
      if (!text) return;
      stop();
      const r = await post(doFetch, `${baseUrl}/voice/speak`, { text });
      if (!r.ok) throw new Error(`/voice/speak HTTP ${r.status}`);
      const url = URL.createObjectURL(await r.blob());
      const audio = new Audio(url);
      await new Promise((done) => {
        playing = { audio, url, done };
        audio.onended = audio.onerror = () => { if (playing?.audio === audio) stop(); else done(); };
        audio.onplaying = () => onStart?.();
        audio.play().catch(() => stop());
      });
    },
    cancel: stop,
  };
}
