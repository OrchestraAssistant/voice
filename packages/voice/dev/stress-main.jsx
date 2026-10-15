import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { ListeningGlow } from "../src/ListeningGlow.jsx";
import { OverlayProvider } from "../src/ScreenOverlay.jsx";
import { useRimTuning } from "../src/rimTuningDev.js"; // TEMPORARY

/**
 * Entry point for stress.html -- the "host app we don't know" harness.
 *
 * Deliberately NOT the demo app: no router, no query client, no
 * VoiceProvider, no index.css. Just the rim, mounted into a hostile page's
 * DOM the way a customer's app would mount it, so what's being tested is
 * the overlay itself and not any support the demo app happens to give it.
 *
 * <OverlayProvider> is the one piece that has to be here. It mounts the
 * single overlay all widget chrome draws into, and an app normally gets it
 * from <VoiceProvider> -- which this page deliberately does without, since
 * a realtime session has nothing to do with what is being tested.
 *
 * `active` is driven by a button here rather than by a live mic session,
 * so the visual can be checked without an OpenAI key.
 */
function StressHarness() {
  const [active, setActive] = useState(true);
  // Shares the panel's tuning store, so a rim dialled in on the demo app
  // shows up here on the dark background too. TEMPORARY.
  const rim = useRimTuning();

  return (
    <OverlayProvider>
      <ListeningGlow active={active} width={rim.width} cornerRadius={rim.corner} />
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button id="toggle-glow" type="button" onClick={() => setActive((a) => !a)}>
          {active ? "Stop listening" : "Start listening"}
        </button>
        <button id="open-dialog" type="button" onClick={() => document.getElementById("host-dialog").showModal()}>
          Open host modal
        </button>
        <button id="open-popover" type="button" onClick={() => document.getElementById("host-popover").showPopover()}>
          Open host popover
        </button>
      </div>
    </OverlayProvider>
  );
}

createRoot(document.getElementById("widget-mount")).render(
  <StrictMode>
    <StressHarness />
  </StrictMode>,
);
