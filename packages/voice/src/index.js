// Public API of @expert/voice.
//
// Three layers, all built on the same hook, in increasing order of "we
// made the decisions for you":
//
//   useInterpreter()    -- headless. All state and controls; build any UI.
//   <InterpreterPanel/> -- the full functional UI, unpositioned; drop it
//                          wherever you want the controls to live.
//   <InterpreterBubble/> -- the default drop-in: floating bubble that
//                          expands into the panel.
//
// Connection state and listening state are separate throughout:
//   transport    -- "idle" | "connecting" | "ready" | "error". Is the realtime
//                   connection up. Says nothing about the microphone.
//   micAttached  -- is a microphone actually on that session.
//   isListening({ transport, micAttached, mode, holding })
//                -- the only thing that should drive a "we can hear you"
//                   affordance. A connection can be up with no mic on it.
//
// <VoiceProvider> is required around all of them: besides the session, it
// mounts the single overlay every piece of chrome draws into. <ListeningGlow>
// needs no position of its own -- it renders into that overlay, outside the
// host's DOM -- so it can go anywhere inside the provider.

// Imported here so the build emits dist/voice.css. Vite extracts it, so
// importing this PACKAGE does NOT inject anything into a host document.
//
// THE DEFAULT SHADOW MOUNT NEEDS NO STYLESHEET IMPORT. It is self-styling:
// InterpreterBubble injects the compiled sheet into its own shadow root, where
// it can reach nothing else. Importing the sheet into the document instead
// shares a global class namespace with the host: a bare `.hidden` from it once
// landed after a real app's `.md:flex` in the same cascade layer, and media
// queries add no specificity, so that app's desktop sidebar stayed hidden at
// every width -- it silently rendered its mobile layout.
//
// The sheet exists only for mount="inline" on a host that has NO Tailwind of
// its own (the demo is exactly that). It is exported as "@expert/voice/inline.css"
// -- deliberately NOT "styles.css" -- so the reflexive `import
// "@expert/voice/styles.css"` fails loudly at build rather than breaking layout
// in silence. If you are on the default mount and reached for a stylesheet: you
// do not need one. Do not import it.
import "./styles.css";

export { VoiceProvider, useInterpreter } from "./VoiceProvider.jsx";
// The assembled interface: bubble plus rim, wired together. Start here.
export { Interpreter } from "./Interpreter.jsx";
export { InterpreterBubble } from "./InterpreterBubble.jsx";
export { InterpreterPanel } from "./InterpreterPanel.jsx";
export { ListeningGlow } from "./ListeningGlow.jsx";
export { Spotlight } from "./Spotlight.jsx";
export { isListening, rimState } from "./listening.js";
export { PALETTES, SWATCHES } from "./palettes.js";

// Providers -- the swappable voice-to-action pipeline (see PROVIDERS.md).
// `openaiRealtime()` is the reference provider; implement the same contract
// (a { id, capabilities, connect } object) to plug in another realtime voice API.
export { openaiRealtime } from "./providers/openaiRealtime.js";
export { toolCatalog, validateProvider, REALTIME_CAPABILITIES } from "./providers/contract.js";
