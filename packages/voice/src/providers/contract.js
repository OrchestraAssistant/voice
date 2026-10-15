/**
 * The provider contract: the seam between the core and a voice-to-action
 * pipeline. A provider is everything between "audio in" and "a decided tool
 * call"; the core owns the manifest, the executor (tool calls run in the
 * browser), the confirmation gate, and the UI. See PROVIDERS.md for the full
 * spec and the AI-SDK-provider analogy.
 *
 * The package is JS, so the shapes below are JSDoc documentation; the runtime
 * exports are `toolCatalog` (the neutral manifest projection every provider
 * consumes), `REALTIME_CAPABILITIES`, and `validateProvider`.
 *
 * @typedef {Object} VoiceSession  The live controls the UI drives.
 * @property {() => void} stop
 * @property {(text: string) => void} sendTextTurn
 * @property {() => Promise<MediaStreamTrack>} attachMic
 * @property {() => Promise<void>} releaseMic
 * @property {() => boolean} hasMic
 * @property {(enabled: boolean) => void} setMicEnabled
 * @property {(auto: boolean) => void} setTurnDetection  server-VAD vs manual (PTT)
 * @property {() => void} clearInputBuffer  PTT press: begin a held turn
 * @property {() => void} commitAndRespond  PTT release: finalise and answer
 * @property {() => void} cancelResponse    barge-in
 *
 * @typedef {Object} Capabilities
 * @property {boolean} pushToTalk
 * @property {boolean} bargeIn
 * @property {boolean} textInput
 * @property {boolean} warm
 *
 * @typedef {Object} ProviderDeps
 * @property {object} manifest
 * @property {Array} toolCatalog
 * @property {{onToolCall,onTranscript,onActivity,onStatus,onHangUp,onEvent?}} callbacks
 * @property {"continuous"|"ptt"|"ptnt"} initialMode
 * @property {boolean} withMic
 * @property {*} [minted]
 * @property {AbortSignal} [signal]
 *
 * @typedef {Object} VoiceProviderSpec  The provider object a factory returns.
 * @property {string} id
 * @property {Capabilities} capabilities
 * @property {(deps: ProviderDeps) => Promise<*>} [mint]   pre-acquire a credential
 * @property {(deps: ProviderDeps) => Promise<VoiceSession>} connect
 */

/**
 * The manifest, projected to a neutral tool list a provider re-projects into its
 * own model's format (OpenAI function schema, a JEV choice, a Pipecat tool...).
 * The manifest stays the single source; only the projection is provider-specific.
 * Build-time review flags and date-encoding metadata are dropped -- they are not
 * the model's business.
 */
export function toolCatalog(manifest = {}) {
  const forField = ({ dates, review, ...field }) => field; // strip build-time metadata
  const of = (op, kind) => ({
    name: op.name,
    kind,
    description: (op.description ?? "").replace(/\s+/g, " ").trim(),
    params: (op.params ?? []).map(forField),
    ...(op.bodyFields?.length ? { bodyFields: op.bodyFields.map(forField) } : {}),
    destructive: !!op.requiresConfirmation,
    ...(op.group?.length ? { group: op.group } : {}),
    ...(op.confidence ? { confidence: op.confidence } : {}),
  });
  return [
    ...(manifest.queries ?? []).map((o) => of(o, "query")),
    ...(manifest.actions ?? []).map((o) => of(o, "action")),
  ];
}

/** The capability set of a full-duplex realtime provider (the common case). */
export const REALTIME_CAPABILITIES = Object.freeze({
  pushToTalk: true,
  bargeIn: true,
  textInput: true,
  warm: true,
});

/**
 * Dev-time shape check: does this object satisfy the provider contract? Throws a
 * message aimed at the mistake (e.g. passing the factory instead of calling it),
 * so a broken custom provider fails at mount rather than mid-conversation.
 */
export function validateProvider(p) {
  if (typeof p === "function") {
    throw new Error("A provider must be the object a factory returns -- call it, e.g. provider={openaiRealtime()}.");
  }
  if (!p || typeof p !== "object") throw new Error("A provider must be an object (see PROVIDERS.md).");
  if (typeof p.connect !== "function") throw new Error(`Provider "${p.id ?? "?"}" must implement connect(deps) -> VoiceSession.`);
  if (!p.capabilities || typeof p.capabilities !== "object") {
    throw new Error(`Provider "${p.id ?? "?"}" must declare capabilities { pushToTalk, bargeIn, textInput, warm }.`);
  }
  return p;
}
