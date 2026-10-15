import { useState } from "react";
import { useInterpreter } from "./VoiceProvider.jsx";
import { useRimTuning, setRimTuning, resetRimTuning } from "./rimTuningDev.js"; // TEMPORARY

const MODES = [
  { id: "continuous", label: "Continuous" },
  { id: "ptt", label: "Push to talk" },
  { id: "ptnt", label: "Push to not talk" },
];

/**
 * The full functional interpreter UI -- mode selector, connect/hold
 * controls, confirmation banner, transcript, text-command fallback. Built
 * entirely on useInterpreter(), same as any custom UI would be. Usable on
 * its own (embed it wherever you want the panel to live) or wrapped by
 * <InterpreterBubble/> for the floating drop-in version.
 */
export function InterpreterPanel() {
  const {
    transport,
    micAttached,
    transcript,
    pendingAction,
    error,
    mode,
    holding,
    start,
    stop,
    sendText,
    confirmManually,
    cancelManually,
    setMode,
    holdStart,
    holdEnd,
    capabilities,
  } = useInterpreter();
  const [textInput, setTextInput] = useState("");
  const live = transport === "ready" && micAttached;
  const rim = useRimTuning(); // TEMPORARY

  // Only the modes the live engine supports -- a cascade that cannot hold a
  // turn offers continuous only, so push-to-talk never appears as a dead button.
  const modes = MODES.filter((m) => m.id === "continuous" || capabilities.pushToTalk);

  const holdLabel = mode === "ptt" ? (holding ? "Listening..." : "Hold to talk") : holding ? "Muted" : "Hold to mute";

  return (
    <div className="interpreter-panel">
      <div className="mode-selector">
        {modes.map((m) => (
          <button
            key={m.id}
            className={mode === m.id ? "mode-active" : ""}
            onClick={() => setMode(m.id)}
            type="button"
          >
            {m.label}
          </button>
        ))}
      </div>

      <button
        id="voice-mic-button"
        className={`mic-button mic-${transport}`}
        onClick={live || transport === "connecting" ? stop : start}
      >
        {live ? "Stop" : transport === "connecting" ? "Connecting..." : "Talk"}
      </button>

      {live && mode !== "continuous" && (
        <button
          id="voice-hold-button"
          type="button"
          className={`hold-button ${holding ? "holding" : ""}`}
          onMouseDown={holdStart}
          onMouseUp={holdEnd}
          onMouseLeave={holdEnd}
          onTouchStart={(e) => {
            e.preventDefault();
            holdStart();
          }}
          onTouchEnd={(e) => {
            e.preventDefault();
            holdEnd();
          }}
        >
          {holdLabel}
        </button>
      )}
      {live && mode !== "continuous" && <span className="hold-hint">or hold Ctrl+Space</span>}

      <span className="voice-status">{live ? transport : `${transport} (mic off)`}</span>
      {error && <p className="error">{error}</p>}

      {pendingAction && (
        <div className="confirm-banner">
          <p>
            Confirm: <strong>{pendingAction.description}</strong>{" "}
            {pendingAction.count > 1 ? `× ${pendingAction.count}` : JSON.stringify(pendingAction.args)}
          </p>
          <button onClick={confirmManually}>Confirm</button>
          <button onClick={cancelManually}>Cancel</button>
        </div>
      )}

      <div className="transcript">
        {transcript.slice(-6).map((turn, i) => (
          <p key={i} className={`turn turn-${turn.role}`}>
            <strong>{turn.role}:</strong> {turn.text}
          </p>
        ))}
      </div>

      {capabilities.textInput && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (textInput.trim()) sendText(textInput.trim());
            setTextInput("");
          }}
        >
          <input
            aria-label="Type a voice command for testing"
            placeholder="Or type a command to test without a mic..."
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
          />
          <button type="submit">Send</button>
        </form>
      )}

      {/* TEMPORARY -- rim geometry tuning, see rimTuningDev.js. At the bottom
          so it doesn't read as part of the voice controls. The rim only
          draws while listening, so `?glow=1` is the way to tune it without a
          live session. */}
      <div className="rim-tuning">
        <span className="hold-hint">Rim geometry (temporary)</span>
        {[
          { key: "width", label: "Width", min: 8, max: 300 },
          { key: "corner", label: "Inner corner — bloom ‹ 0 › carve", min: -500, max: 500 },
        ].map(({ key, label, min, max }) => (
          <label key={key}>
            <span>
              {label} <b>{rim[key]}px</b>
            </span>
            <input
              type="range"
              min={min}
              max={max}
              value={rim[key]}
              onChange={(e) => setRimTuning({ [key]: Number(e.target.value) })}
            />
          </label>
        ))}
        <button type="button" onClick={resetRimTuning}>
          Reset to 80 / 0
        </button>
      </div>
    </div>
  );
}
