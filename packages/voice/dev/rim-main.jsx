import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { OverlayProvider } from "../src/ScreenOverlay.jsx";
import { ListeningGlow } from "../src/ListeningGlow.jsx";
import { PALETTES, STATES, SWATCHES, meanSat, nearestHue } from "../src/palettes.js";

/**
 * Tuning page for the rim, which is the one part of this widget that cannot be
 * settled by a test. Colour, timing and the feel of a state change are eye
 * decisions; everything here exists so they can be made against the real
 * component over real content instead of guessed from a screenshot.
 *
 * No VoiceProvider: the rim takes `active` and `state` as plain props, so a
 * live session would only get in the way of driving them by hand.
 */

const Slider = ({ label, value, onChange, min, max, step = 1, unit = "" }) => (
  <label>
    <span className="name">{label}</span>
    <input type="range" min={min} max={max} step={step} value={value}
      onChange={(e) => onChange(Number(e.target.value))} />
    <output>{value}{unit}</output>
  </label>
);

// "Distinct" should be visible while tuning, not discovered afterwards.
// Space is tight: listening and working between them leave two narrow bands,
// 25-84 degrees and 271-360, so a palette needs to sit in one and stay clear
// of both edges. The readout turns red the moment an edit breaks that.
const Palette = ({ name, colors, active, others, swatch, onChange }) => {
  const gap = Math.round(nearestHue(colors, others));
  const sat = meanSat(colors);
  const ok = gap >= 18;
  return (
  <fieldset style={active ? { borderColor: "currentColor" } : undefined}>
    <legend>
      {name}{swatch ? ` · ${swatch}` : ""}{active ? " ●" : ""}{" "}
      <span style={{ opacity: 0.7, color: ok ? "inherit" : "#dc2626" }}>
        {gap}° · sat {sat.toFixed(2)}{ok ? "" : " ✗ too close"}
      </span>
    </legend>
    {colors.map((c, i) => (
      <label key={i}>
        <span className="name">stop {i + 1}</span>
        <input type="color" value={c}
          onChange={(e) => onChange(colors.map((x, j) => (j === i ? e.target.value : x)))} />
        <output>{c.toUpperCase()}</output>
      </label>
    ))}
    <div className="swatches">{colors.map((c, i) => <i key={i} style={{ background: c }} />)}</div>
  </fieldset>
  );
};

function Tuner() {
  const [palettes, setPalettes] = useState(PALETTES);
  const [state, setState] = useState("listening");
  const [on, setOn] = useState(true);
  const [cycle, setCycle] = useState(false);
  const [width, setWidth] = useState(80);
  const [corner, setCorner] = useState(0);
  const [rotationMs, setRotationMs] = useState(5000);
  const [crossfadeMs, setCrossfadeMs] = useState(1200);
  const [space, setSpace] = useState("oklch");
  const [dark, setDark] = useState(false);

  useEffect(() => { document.body.classList.toggle("dark", dark); }, [dark]);

  // A real turn runs ready to listening to working to speaking and back, and
  // the transitions only make sense judged in that order at that pace.
  useEffect(() => {
    if (!cycle) return;
    let i = 0;
    const id = setInterval(() => { i = (i + 1) % STATES.length; setState(STATES[i]); }, 2200);
    return () => clearInterval(id);
  }, [cycle]);

  const setOne = (name) => (colors) => setPalettes((p) => ({ ...p, [name]: colors }));

  return (
    <>
      <ListeningGlow
        active={on}
        state={state}
        width={width}
        cornerRadius={corner}
        palettes={palettes}
        rotationMs={rotationMs}
        crossfadeMs={crossfadeMs}
        space={space}
      />

      <div className="states">
        {STATES.map((s) => (
          <button key={s} aria-pressed={on && state === s}
            onClick={() => { setCycle(false); setOn(true); setState(s); }}>
            {s}
          </button>
        ))}
        <button aria-pressed={!on} onClick={() => { setCycle(false); setOn(false); }}>off</button>
        <button aria-pressed={cycle} onClick={() => { setOn(true); setCycle((c) => !c); }}>cycle a turn</button>
        <button aria-pressed={dark} onClick={() => setDark((d) => !d)}>dark page</button>
      </div>

      <div className="panel">
        {STATES.map((s) => (
          <Palette key={s} name={s} colors={palettes[s]} active={on && state === s}
            others={STATES.filter((o) => o !== s).map((o) => palettes[o])}
            swatch={Object.keys(SWATCHES).find((k) => SWATCHES[k].join() === palettes[s].join())}
            onChange={setOne(s)} />
        ))}
        <fieldset>
          <legend>timing &amp; shape</legend>
          <Slider label="rotation" value={rotationMs} onChange={setRotationMs} min={1000} max={12000} step={250} unit="ms" />
          <Slider label="crossfade" value={crossfadeMs} onChange={setCrossfadeMs} min={0} max={3000} step={50} unit="ms" />
          <Slider label="band width" value={width} onChange={setWidth} min={20} max={200} unit="px" />
          <Slider label="inner corner" value={corner} onChange={setCorner} min={-500} max={500} step={10} unit="px" />
          <label>
            <span className="name">mix in</span>
            <select value={space} onChange={(e) => setSpace(e.target.value)}>
              <option value="oklch">OKLCh (even, and around the hue wheel)</option>
              <option value="oklab">OKLab (even, but straight through grey)</option>
              <option value="linear">linear light</option>
              <option value="srgb">sRGB</option>
            </select>
          </label>
        </fieldset>
      </div>

      <pre>{`// paste into packages/voice/src/palettes.js
export const PALETTES = {
${STATES.map((s) => `  ${s}: ${JSON.stringify(palettes[s].map((c) => c.toUpperCase()))},`).join("\n")}
};

// and the props, if these changed
rotationMs={${rotationMs}} crossfadeMs={${crossfadeMs}} space="${space}"
width={${width}} cornerRadius={${corner}}`}</pre>
    </>
  );
}

createRoot(document.getElementById("controls")).render(
  <StrictMode>
    <OverlayProvider>
      <Tuner />
    </OverlayProvider>
  </StrictMode>,
);
