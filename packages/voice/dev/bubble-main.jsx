import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { VoiceProvider } from "../src/VoiceProvider.jsx";
import { InterpreterBubble } from "../src/InterpreterBubble.jsx";
import { ListeningGlow } from "../src/ListeningGlow.jsx";
import { Interpreter } from "../src/Interpreter.jsx";
import * as dom from "../src/domActions.js";
import { fakeProviders } from "./fake-providers.js";

// The harness's own instance of the DOM tools, so a check driven from outside
// the page acts on the SAME module the components subscribe to. Importing
// them again by URL gets a second copy -- Vite appends a cache-busting query
// after a hot update, and two copies of a module that holds state agree about
// nothing. Dev harness only; `files` ships dist/.
window.__dom = dom;


/**
 * Entry point for bubble.html -- the *clean* host, as opposed to
 * stress.html's hostile one. There is no relay behind this page, so the
 * manifest fetch fails and the session never connects; that's fine, since
 * what this harness is for is the panel's shell -- sizing, the open/close
 * animation, the tab strip -- which doesn't depend on a live session.
 */
const params = new URLSearchParams(window.location.search);
const MOUNT = params.get("mount") === "shadow" ? "shadow" : "inline";

// Only the inline mount needs this. It has no shadow root to inject into, so
// the stylesheet has to reach the document the way a host app's
// `import "@expert/voice/styles.css"` does -- and in the document it shares a
// global class namespace with the host, which is how a bare `.hidden` from
// here once overrode a real app's responsive sidebar. In shadow mode the
// bubble injects the compiled sheet into its own root, so importing it here
// would be pure contamination.
if (MOUNT === "inline") await import("../src/styles.css");
if (params.get("bg") === "dark") document.body.classList.add("dark");

/**
 * Query inside the widget wherever it happens to be mounted -- the host tree
 * at mount="inline", or the overlay's shadow root.
 *
 * The root being OPEN is what makes this possible at all. It was closed
 * until recently, and reaching in then meant patching
 * Element.prototype.attachShadow before React ran -- six lines, which is
 * also the reason a closed root was never the security boundary it looked
 * like. Note that a plain document.querySelector still does not descend into
 * an open root either, so the widget stays invisible to the host page and to
 * our own dom_snapshot tools; you have to ask for .shadowRoot deliberately,
 * as here.
 */
function inWidget(selector) {
  const roots = [document, ...[...document.querySelectorAll("[data-interpreter-overlay]")].map((h) => h.shadowRoot)];
  for (const root of roots) {
    const el = root?.querySelector(selector);
    if (el) return el;
  }
  return null;
}

/**
 * Keyboard driver: 1 selects the Talk tab, 2 selects Settings, each toggling
 * as a real click would. It exists because the panel cannot be driven from
 * outside itself. A selector cannot reach into the shadow root, and clicking
 * a button on this page to proxy the click is worse than useless: the
 * mousedown lands outside the widget, click-outside fires, and the panel
 * closes before the proxied click arrives. A keydown touches neither.
 */
document.addEventListener("keydown", (e) => {
  const label = { 1: "Talk", 2: "Settings" }[e.key];
  if (label) inWidget(`.interpreter-widget button[aria-label="${label}"]`)?.click();

  // 3 -- a pointer press on a control INSIDE the panel, which must NOT close
  // it. This is the other half of click-outside and the half that is easy to
  // get wrong: the listener sits on document, where `event.target` has been
  // retargeted to the shadow host, so the check has to read composedPath()
  // instead. `composed: true` is what real UI events carry and what lets that
  // path cross the boundary at all, so this is a faithful stand-in for a
  // click a selector cannot reach.
  if (e.key === "3") {
    inWidget(".interpreter-widget form input")?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, composed: true }),
    );
  }
});

// ?glow=1 mounts the listening rim alongside the panel, so both layers of the
// overlay are occupied at once. Neither piece of chrome can misbehave on its
// own -- the flicker that led here needed both of them up -- and nothing else
// in the repo puts them on the same page: stress.html has only the rim, and
// the demo app cannot be driven from outside.
// Same origin by default: vite.dev.config.js proxies /voice to the relay.
// Pointing straight at http://localhost:3002 does NOT work here -- this page
// is served over https through the tunnel, and mixed content is blocked, so
// the fetches fail silently and the settings tab has nothing to offer.
const RELAY = params.get("relay") ?? "";

// A host app supplies its own manifest; this page is standing in for one. Tiny
// on purpose -- what is being exercised here is chrome, not tool coverage.
const MANIFEST = {
  routes: [{ path: "/", component: "Home" }],
  queries: [],
  actions: [],
};

// ?assembled=1 renders the top tier, <Interpreter/>, instead of wiring the
// bubble and the rim by hand. It is the same page either way, which is the
// point: the assembled component must produce what a host would have built.
const ASSEMBLED = params.has("assembled");

// ?providers=multi offers two engines with different capabilities (see
// fake-providers.js), so the engine picker and the capability-adaptive controls
// can be driven with no relay. Omitted, the widget gets its usual single
// realtime provider, which is the default behaviour.
const PROVIDERS = params.get("providers") === "multi" ? fakeProviders() : undefined;

createRoot(document.getElementById("widget-mount")).render(
  <StrictMode>
    <VoiceProvider relayUrl={RELAY} manifest={MANIFEST} providers={PROVIDERS}>
      {ASSEMBLED ? (
        <Interpreter mount={MOUNT} />
      ) : (
        <>
          {params.has("glow") && <ListeningGlow active />}
          <InterpreterBubble mount={MOUNT} />
        </>
      )}
    </VoiceProvider>
  </StrictMode>,
);

// ?trace=1 -- two recorders, both written into the page for inspect_page to
// read back, because neither question a screenshot can answer.
//
//   #trace   the resize, frame by frame. You cannot see a 350ms overshoot in
//            a still. `inner` holding steady while `outer` moves toward it is
//            what a healthy transition looks like; `inner` moving too means
//            the content is reflowing mid-transition, and `inner` reading as
//            the sum of both panes means the outgoing one never left the flow.
//   #toggles top-layer churn. A handful of toggle events is healthy. Thousands
//            means something is re-raising itself in a loop -- which is what
//            two separate overlay hosts used to do to each other.
if (params.has("trace")) {
  let toggles = 0;
  document.addEventListener("toggle", () => toggles++, true);
  setInterval(() => {
    document.getElementById("toggles").textContent = `toggle events: ${toggles}`;
  }, 200);

  const out = document.getElementById("trace");
  const record = () => {
    const rows = [];
    const t0 = performance.now();
    const tick = () => {
      const outer = inWidget(".interpreter-widget > div");
      const inner = outer?.firstElementChild;
      // Everything in the wrapper except the tab strip, which is absolute and
      // so contributes nothing to the measured height. Two entries mean a
      // transition is mid-flight: the outgoing pane and the incoming one.
      const panes = inner ? [...inner.children].filter((c) => !c.className.includes("absolute")) : [];
      const box = (el) => `${el?.offsetHeight}x${el?.offsetWidth}`;
      rows.push(
        `${String(Math.round(performance.now() - t0)).padStart(4)}  outer ${box(outer)}  inner ${box(inner)}  panes ${panes.map((p) => p.offsetHeight).join(",")}`,
      );
      if (performance.now() - t0 < 1200) requestAnimationFrame(tick);
      else out.textContent = rows.filter((_, i) => i % 3 === 0).join("\n");
    };
    requestAnimationFrame(tick);
  };
  document.addEventListener("click", record, true);
  document.addEventListener("keydown", record, true);
}
