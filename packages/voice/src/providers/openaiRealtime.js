/**
 * The reference provider: OpenAI Realtime.
 *
 * It is the first citizen of the provider contract (PROVIDERS.md) -- it wraps the
 * existing realtime client and the relay mint into a { id, capabilities, mint,
 * connect } object. The wrap is thin because `connectRealtimeSession` already
 * returns a VoiceSession-shaped object; this file's job is to name that as a
 * provider, pin its options, and expose the ephemeral-key pre-warm as `mint`.
 *
 * Its server half is the relay (see relay/ and README "Securing the relay"),
 * which holds OPENAI_API_KEY and builds the OpenAI tool schema from the manifest.
 * That relay belongs to THIS provider, not the core.
 */
import { connectRealtimeSession, mintSession, isUsable } from "../realtimeClient.js";
import { REALTIME_CAPABILITIES } from "./contract.js";

/**
 * @param {{ relayUrl?: string, model?: string, language?: object }} [options]
 * @returns {import("./contract.js").VoiceProviderSpec}
 */
export function openaiRealtime(options = {}) {
  const { relayUrl = "", model, language } = options;

  return {
    id: "openai-realtime",
    capabilities: REALTIME_CAPABILITIES,

    /**
     * Pre-acquire an ephemeral key. Reused while still valid AND minted for the
     * same model+language (a key is minted for both and neither can change on a
     * live session), so warming on hover makes the first "talk" instant.
     * Warming never surfaces an error -- nobody asked to speak yet.
     */
    async mint(deps = {}) {
      const wanted = {
        model: deps.model ?? model ?? null,
        language: deps.language ?? language ?? null,
      };
      if (isUsable(deps.minted, wanted)) return deps.minted;
      try {
        return await mintSession({ relayUrl: deps.relayUrl ?? relayUrl, ...wanted, manifest: deps.manifest });
      } catch {
        return null;
      }
    },

    /**
     * Open the live session. A pass-through to the realtime client, mapping the
     * provider's `callbacks` bundle onto its callback parameters and forwarding
     * the session-creation options. `openTransport` is forwarded so a test can
     * drive the protocol with no WebRTC.
     */
    connect(deps = {}) {
      const { manifest, callbacks = {}, initialMode = "continuous", withMic = true, minted } = deps;
      return connectRealtimeSession({
        relayUrl: deps.relayUrl ?? relayUrl,
        model: deps.model ?? model,
        language: deps.language ?? language,
        manifest,
        surface: deps.surface,
        initialMode,
        withMic,
        minted,
        openTransport: deps.openTransport,
        onToolCall: callbacks.onToolCall,
        onStatus: callbacks.onStatus,
        onTranscript: callbacks.onTranscript,
        onActivity: callbacks.onActivity,
        onHangUp: callbacks.onHangUp,
        onEvent: callbacks.onEvent,
      });
    },
  };
}
