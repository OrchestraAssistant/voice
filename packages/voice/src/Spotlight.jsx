import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { clearHighlight, highlightRect, subscribeHighlight } from "./domActions.js";
import { FALLOFF } from "./ListeningGlow.jsx";
import { OverlayLayer } from "./ScreenOverlay.jsx";

/**
 * A ring around one element of the HOST app, for answering "where is the
 * submit button" by pointing rather than by describing.
 *
 * Almost all of this was already built. The overlay is a viewport-sized fixed
 * box in a shadow root, mounted outside the host's tree, in the browser's top
 * layer, with `pointer-events: none` -- so a ring drawn in it sits above an
 * app whose markup and CSS we have never seen, cannot be clipped by an
 * ancestor's overflow, and never eats the click on the thing it is pointing
 * at. That last part matters: the whole point is that the user then presses
 * the button themselves.
 *
 * Position is tracked per frame rather than computed once. An element's
 * rectangle moves on scroll, on resize, and on every re-render, and the ring
 * has to stay on it or it becomes a lie. The cost is one
 * getBoundingClientRect and one transform per frame, on a single element --
 * which §31 measured as free: an animated full-viewport gradient held a flat
 * 60fps, and it was the ten-layer MASK that cost 21. There is no mask here.
 */

/** The panel's own accent, so the widget points in the colour it already is. */
const ACCENT = "91, 59, 255"; // --iv-accent, #5b3bff

/**
 * How far the halo reaches past the ring, in px. The rim's FALLOFF is written
 * at an 80px scale, so this is a rescale of the same curve rather than a
 * second set of hand-picked numbers.
 */
const HALO = 20;

/** How far the ring sits outside the element, so it frames rather than covers. */
const INSET = 4;

/**
 * The halo, built from the rim's own decay.
 *
 * FALLOFF is an error function -- the reference component's blurred cover,
 * solved, see ListeningGlow -- and its shape is why the rim reads as light
 * rather than as a band with an edge. Reusing the curve is what makes these
 * two look drawn by the same hand, and it is the one kind of family
 * resemblance that cannot quietly drift apart.
 *
 * Each stop becomes a spread ring at that distance and alpha, listed outermost
 * FIRST: box-shadows paint with the earliest on top, so the faint wide ones
 * belong underneath the tight strong ones.
 *
 * Every ring is BLURRED by a quarter of the halo, and that is not decoration.
 * The curve being reproduced is a gaussian, and eleven hard-edged rings across
 * twenty pixels are visibly eleven rings -- stepped, especially around a
 * corner where they fan out. A blur wider than the gap between stops merges
 * them back into the smooth decay the numbers describe. Alphas are scaled down
 * to compensate, since blurred rings overlap where sharp ones abutted.
 */
const BLUR = HALO / 4;

const halo = [...FALLOFF]
  .reverse()
  .filter(([, alpha]) => alpha > 0)
  .map(
    ([px, alpha]) =>
      `0 0 ${BLUR}px ${((px / 80) * HALO).toFixed(1)}px rgba(${ACCENT}, ${(alpha * 0.28).toFixed(3)})`,
  )
  .join(", ");

const RING_CSS = `
  /* Two elements, because they move on different clocks. The frame carries
     position, written straight to the node every frame; the ring inside it
     carries the entrance, driven by a spring. One element would mean framer
     and the follow loop both writing \`transform\`, and whichever wrote last
     that frame would win. */
  .spotlight-frame {
    position: absolute;
    top: 0;
    left: 0;
    pointer-events: none;
    opacity: 0;
  }

  .spotlight-ring {
    position: absolute;
    inset: -${INSET}px;
    border-radius: var(--ring-radius, 10px);
    /* A hairline of light first, so the accent separates from a dark control
       as readily as from a pale one, then the accent itself. */
    box-shadow:
      0 0 0 1.5px rgba(255, 255, 255, 0.85),
      0 0 0 3.5px rgba(${ACCENT}, 0.95);
  }

  /* Breathing, not pulsing, and only the halo. The ring's edge stays welded to
     the element -- scaling an outline drifts it off the thing it is framing,
     which is the one impression a pointer cannot afford. */
  @keyframes spotlight-breathe {
    0%, 100% { opacity: 0.5; }
    50% { opacity: 1; }
  }

  .spotlight-halo {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: ${halo};
    animation: spotlight-breathe 2.6s ease-in-out infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .spotlight-halo { animation: none; opacity: 0.85; }
  }
`;

/**
 * The element's corners plus the ring's inset, so the ring is concentric with
 * what it frames rather than merely near it.
 *
 * `calc()` because a computed radius is `8px` on most things and `50%` on a
 * circular avatar, and both are legal inside it. An elliptical corner computes
 * to two values ("10px 20px"), which calc cannot take, so those pass through
 * unchanged -- slightly wrong, and much better than invalid CSS that drops the
 * radius altogether and squares off a circle.
 */
function ringRadius(radii = []) {
  return radii.map((value) => (value.includes(" ") ? value : `calc(${value} + ${INSET}px)`)).join(" ");
}

export function Spotlight() {
  // The criteria, not the box. A change here starts and stops the loop; the
  // box itself never passes through React.
  const [target, setTarget] = useState(null);
  const frame = useRef(null);

  useEffect(() => subscribeHighlight(setTarget), []);

  // Pressing anything dismisses it. The ring exists to get someone to the
  // control, so the moment they act on it the job is done -- and a ring left
  // over a button already pressed reads as the widget being stuck. Capture
  // phase, so it fires whatever the host does with the event, and
  // `clearHighlight` on the module rather than `setTarget` here, so every
  // subscriber agrees the ring is gone.
  useEffect(() => {
    if (!target) return;
    const dismiss = () => clearHighlight();
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [target]);

  useEffect(() => {
    if (!target) return;
    let raf = 0;
    const follow = () => {
      const el = frame.current;
      if (el) {
        const box = highlightRect();
        if (!box) {
          // The element has gone -- navigated away from, or a dialog closed.
          // Fading out beats freezing a ring over whatever now occupies that
          // rectangle, which would be pointing confidently at the wrong thing.
          el.style.opacity = "0";
        } else {
          el.style.opacity = "1";
          el.style.transform = `translate(${box.left}px, ${box.top}px)`;
          el.style.width = `${box.width}px`;
          el.style.height = `${box.height}px`;
          el.style.setProperty("--ring-radius", ringRadius(box.radius));
        }
      }
      raf = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(raf);
  }, [target]);

  return (
    <OverlayLayer name="spotlight" css={RING_CSS} active={false}>
      {/* `active: false` on purpose. A ring is ambient, like the rim: it should
          never displace a host's open dialog in the top layer, and the element
          it points at is often inside one. */}
      <AnimatePresence>
        {target ? (
          <div ref={frame} className="spotlight-frame">
            {/* Scaling in from slightly wide, the way a lens finds focus. The
                same spring the panel opens with -- bounce 0, half a second --
                because two pieces of one widget arriving differently is what
                makes a thing feel assembled rather than designed. */}
            <motion.div
              className="spotlight-ring"
              initial={{ opacity: 0, scale: 1.12 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 1.04 }}
              transition={{ type: "spring", bounce: 0, duration: 0.5 }}
            >
              <div className="spotlight-halo" />
            </motion.div>
          </div>
        ) : null}
      </AnimatePresence>
    </OverlayLayer>
  );
}
