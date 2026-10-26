/**
 * The microphone, cut into turns: capture at 16 kHz mono, an energy VAD that
 * ends a turn after a pause, and push-to-talk. What a turn's audio becomes
 * (text, from liveStt or clipStt) is the caller's `onTurn(Float32Array)`.
 *
 * BROWSER ONLY: getUserMedia and an AudioContext.
 *
 * options:
 *   silenceMs  end-of-turn silence before a turn finalises   default 700
 *   threshold  RMS above which a frame counts as speech        default 0.012
 *   maxTurnMs  hard cap on a single buffered turn              default 20000
 *   sampleRate                                                 default 16000
 *   onFrame    each frame of a turn as it is captured, for a streaming
 *              transcriber (liveStt); onTurn still gets the whole turn
 */
export function micTurns({ onTurn, onFrame, silenceMs = 700, threshold = 0.012, maxTurnMs = 20000, sampleRate = 16000 } = {}) {
  let ctx = null;
  let stream = null;
  let source = null;
  let processor = null;
  let handlers = {};
  let enabled = true;
  let auto = true; // VAD mode; false = push-to-talk
  let speaking = false;
  let holding = false;
  let lastVoiceAt = 0;
  let turnStartedAt = 0;
  let buffer = []; // Float32Array frames at `sampleRate`

  const keep = (frame) => {
    buffer.push(frame);
    onFrame?.(frame);
  };

  function flatten() {
    const total = buffer.reduce((n, f) => n + f.length, 0);
    const out = new Float32Array(total);
    let i = 0;
    for (const f of buffer) { out.set(f, i); i += f.length; }
    buffer = [];
    return out;
  }

  async function finalizeTurn() {
    if (!buffer.length) return;
    try {
      const text = ((await onTurn(flatten())) ?? "").trim();
      if (text) handlers.onFinal?.(text);
    } catch (err) {
      handlers.onError?.(err);
    }
  }

  function onAudio(e) {
    if (!enabled) return;
    const input = e.inputBuffer.getChannelData(0);
    const now = Date.now();

    if (!auto) {
      // push-to-talk: only capture while held (beginTurn/endTurn drive it)
      if (holding) keep(new Float32Array(input));
      return;
    }

    // energy VAD
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);

    if (rms >= threshold) {
      if (!speaking) { speaking = true; turnStartedAt = now; handlers.onSpeechStart?.(); }
      lastVoiceAt = now;
      keep(new Float32Array(input));
    } else if (speaking) {
      keep(new Float32Array(input)); // keep trailing audio
      if (now - lastVoiceAt >= silenceMs) {
        speaking = false;
        handlers.onSpeechEnd?.();
        finalizeTurn();
      }
    }
    // a runaway turn (no silence) is cut and transcribed so it can't grow forever
    if (speaking && now - turnStartedAt >= maxTurnMs) {
      speaking = false;
      handlers.onSpeechEnd?.();
      finalizeTurn();
    }
  }

  async function attachMic() {
    if (stream) return stream;
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
    source = ctx.createMediaStreamSource(stream);
    // ScriptProcessorNode is deprecated but needs no separate worklet file; fine
    // for a reference client. Swap for an AudioWorklet if you productionise this.
    processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = onAudio;
    source.connect(processor);
    processor.connect(ctx.destination);
    return stream;
  }

  function teardown() {
    processor?.disconnect();
    source?.disconnect();
    stream?.getTracks().forEach((t) => t.stop());
    ctx?.close?.();
    processor = source = stream = ctx = null;
    buffer = [];
    speaking = false;
  }

  return {
    /** Wire the cascade's handlers; attach the mic unless `withMic: false`. */
    async start(h = {}) {
      handlers = h;
      enabled = h.withMic !== false;
      if (enabled) await attachMic();
    },
    stop: teardown,
    setEnabled(on) { enabled = on; },
    setTurnDetection(a) { auto = a; },
    beginTurn() { holding = true; buffer = []; handlers.onSpeechStart?.(); }, // PTT press
    endTurn() { holding = false; handlers.onSpeechEnd?.(); finalizeTurn(); }, // PTT release
    attachMic,
    async releaseMic() { teardown(); },
    hasMic: () => !!stream,
  };
}

/** 16-bit PCM WAV of mono float samples: what a transcription API takes. */
export function wavOf(samples, sampleRate = 16000) {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (at, s) => { for (let i = 0; i < s.length; i++) out.setUint8(at + i, s.charCodeAt(i)); };
  str(0, "RIFF"); out.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, sampleRate, true); out.setUint32(28, sampleRate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  str(36, "data"); out.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}

/** Bytes -> base64, in chunks (String.fromCharCode on a whole clip overflows the stack). */
export function base64Of(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return typeof btoa === "function" ? btoa(s) : Buffer.from(bytes).toString("base64");
}
