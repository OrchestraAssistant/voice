/**
 * Browser-local STT via Moonshine (transformers.js / ONNX Runtime Web, WebGPU
 * with WASM fallback). Audio never leaves the page; the model weights download
 * once and cache in the browser. Pairs with moonshineJev().
 *
 * BROWSER ONLY. It uses getUserMedia and an AudioContext, so it does nothing in
 * Node. transformers.js is NOT imported here (that would pull a heavy, optional
 * dep into the core bundle); the dev supplies it, so the bare specifier lives in
 * THEIR app, not ours:
 *
 *   moonshineStt({ loadTransformers: () => import("@huggingface/transformers") })
 *
 * options:
 *   loadTransformers  () => Promise<module>  REQUIRED -- how to load transformers.js
 *   model   HF id            default "onnx-community/moonshine-base-ONNX"
 *   device  "webgpu"|"wasm"  default "webgpu"
 *   silenceMs  end-of-turn silence before a turn finalises   default 700
 *   threshold  RMS above which a frame counts as speech        default 0.012
 *   maxTurnMs  hard cap on a single buffered turn              default 20000
 *
 * Returns the STT client the cascade loop drives: start/stop, setEnabled,
 * setTurnDetection (VAD vs push-to-talk), beginTurn/endTurn (PTT), attach/release/hasMic.
 */
/** Friendly size names -> the onnx-community model ids transformers.js loads. */
export const MOONSHINE_MODELS = {
  tiny: "onnx-community/moonshine-tiny-ONNX", // ~27M params: faster, smaller, best on the wasm fallback
  base: "onnx-community/moonshine-base-ONNX", // ~61M params: more accurate, best on webgpu
};

export function moonshineStt(options = {}) {
  const {
    loadTransformers,
    size = "base", // "tiny" | "base"; or pass `model` for any transformers.js ASR id
    model,
    device = "auto", // "auto" probes for a real WebGPU adapter, else falls back to wasm

    silenceMs = 700,
    threshold = 0.012,
    maxTurnMs = 20000,
    sampleRate = 16000, // Moonshine wants 16k mono
  } = options;
  const modelId = model ?? MOONSHINE_MODELS[size] ?? MOONSHINE_MODELS.base;

  let transcriber = null;
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

  async function ensureModel() {
    if (transcriber) return transcriber;
    if (typeof loadTransformers !== "function") {
      throw new Error('moonshineStt needs { loadTransformers: () => import("@huggingface/transformers") } -- install it in your app and pass the import.');
    }
    const t = await loadTransformers();

    // Resolve the device. "auto" uses WebGPU only if a real adapter is reachable
    // -- navigator.gpu can exist while requestAdapter() returns null (no flag, no
    // hardware), which is the "Failed to get GPU adapter" error. Fall back to wasm,
    // which runs everywhere.
    let dev = device;
    if (dev === "auto") {
      dev = "wasm";
      try { if (navigator.gpu && (await navigator.gpu.requestAdapter())) dev = "webgpu"; } catch { /* wasm */ }
    }
    try {
      transcriber = await t.pipeline("automatic-speech-recognition", modelId, { device: dev });
    } catch (err) {
      if (dev === "wasm") throw err;
      handlers.onStatus?.("webgpu failed, retrying on wasm");
      transcriber = await t.pipeline("automatic-speech-recognition", modelId, { device: "wasm" });
    }
    return transcriber;
  }

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
    const audio = flatten();
    try {
      const model = await ensureModel();
      const out = await model(audio); // transformers.js: Float32 @ 16k -> { text }
      const text = (out?.text ?? "").trim();
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
      if (holding) buffer.push(new Float32Array(input));
      return;
    }

    // energy VAD
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
    const rms = Math.sqrt(sum / input.length);

    if (rms >= threshold) {
      if (!speaking) { speaking = true; turnStartedAt = now; handlers.onSpeechStart?.(); }
      lastVoiceAt = now;
      buffer.push(new Float32Array(input));
    } else if (speaking) {
      buffer.push(new Float32Array(input)); // keep trailing audio
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
    async start(h = {}) {
      handlers = h;
      enabled = h.withMic !== false;
      await ensureModel(); // download/compile now, not on first word
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
