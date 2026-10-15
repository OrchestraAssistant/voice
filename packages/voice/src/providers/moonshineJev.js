/**
 * Moonshine (STT) + JEV cascade. A preset of the shared cascade loop
 * (jevCascade.js) whose STT client runs Moonshine IN THE BROWSER, via
 * transformers.js / ONNX Runtime Web (WebGPU with WASM fallback). Audio never
 * leaves the page and the model weights cache after the first download -- the
 * browser-local counterpart to parakeetJev's server STT.
 *
 *   import { moonshineJev, moonshineStt } from "@expert/voice";
 *   moonshineJev({
 *     stt: moonshineStt({ loadTransformers: () => import("@huggingface/transformers") }),
 *     evaluate, generateText, tts,
 *   })
 *
 * JEV (`evaluate`) and the text model (`generateText`) still reach the dev's
 * broker for their keys; only the STT is local. See PROVIDERS.md.
 */
import { jevCascade } from "./jevCascade.js";

export const moonshineJev = (config = {}) => jevCascade(config, "moonshine-jev");
