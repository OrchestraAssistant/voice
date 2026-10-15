/**
 * NVIDIA Parakeet (STT) + JEV cascade. A preset of the shared cascade loop
 * (jevCascade.js) whose STT client runs Parakeet -- typically SERVER-side via
 * sherpa-onnx (ONNX/CPU) or NeMo/Riva (GPU), with the browser streaming audio to
 * it over a WebSocket. The STT, like every service, is injected:
 *
 *   parakeetJev({ stt, evaluate, generateText, tts })
 *
 * See PROVIDERS.md. Would graduate to @expert/voice-parakeet-jev.
 */
import { jevCascade } from "./jevCascade.js";

export const parakeetJev = (config = {}) => jevCascade(config, "parakeet-jev");
