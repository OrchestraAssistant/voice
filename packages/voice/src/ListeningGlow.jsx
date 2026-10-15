import { animate, motion, AnimatePresence, useMotionValue, useTransform } from "framer-motion";
import { useEffect, useRef } from "react";
import { PALETTES, mixPalettes, rimGradient } from "./palettes.js";
import { OverlayLayer } from "./ScreenOverlay.jsx";

/**
 * The animated rainbow rim around the screen edge, signaling real listening
 * state.
 *
 * "base" (see ListeningGlow.base.jsx) is a literal 1:1 port of the pasted
 * Skiper86 component. Confirmed reason it blocks content: its stacking
 * relies on real content sitting *above* the glow (their button wrapper
 * has an explicit z-2) over a mostly-empty demo box -- a setup that can't
 * work for a page where content fills the entire viewport edge to edge.
 * See ListeningGlow.base.jsx's header for the full breakdown.
 *
 * Everything here is the original's -- same four colors, same 5s linear
 * angle sweep, same viewport-sized gradient box, same alpha falloff. The
 * ONE substitution is how the middle is hidden: the original covers it with
 * an opaque `bg-muted` rectangle, which is exactly what makes it unusable
 * over a real app, so that cover is reproduced as a mask instead. See
 * FALLOFF below for the arithmetic tying the two together.
 *
 * It renders into the shared overlay's `rim` layer, not into the host app's
 * tree, and carries the CSS below with it instead of expecting a stylesheet
 * to exist -- so it draws over a host app whose markup and CSS we've never
 * seen. ScreenOverlay.jsx's header has the reasoning.
 */

/**
 * How the rim fades inward, as [distance from the screen edge, alpha].
 *
 * This is not hand-tuned -- it's the original's cover, solved. There, a
 * `bg-muted` rectangle inset 2px with `blur-xl` (Tailwind: `blur(24px)`,
 * i.e. a Gaussian with a 24px standard deviation) sits over a sharp
 * rainbow. A blurred hard edge is an error function, so the fraction of
 * gradient still showing at distance d from the screen edge is
 *
 *     visible(d) = 1 - Φ((d - 2) / 24)
 *
 * evaluated below. Two things fall out of it that are easy to get wrong:
 *
 *   - The peak is 0.53, NOT 1. At the very edge the blurred cover is
 *     already ~47% opaque, so even the brightest part of the reference rim
 *     is a little over half strength. Taking the mask to full alpha (the
 *     previous version did) is precisely why ours read as more intense than
 *     the original.
 *   - The tail is long and very faint -- still ~4% at 44px, not gone until
 *     ~80px. A Gaussian doesn't stop where a linear ramp would.
 *
 * Over a light page the two are equivalent: compositing a `bg-muted` cover
 * at (1 - visible) is the same result as masking to `visible` and letting a
 * near-white page show through. Over a dark app they differ, and the mask
 * is the one that's still correct.
 */
export const FALLOFF = [
  [0, 0.53],
  [4, 0.47],
  [8, 0.4],
  [14, 0.31],
  [20, 0.23],
  [26, 0.16],
  [34, 0.09],
  [44, 0.04],
  [56, 0.012],
  [68, 0.003],
  [80, 0],
];

/* The table above is written at its natural 80px scale; the band width is
   then a live multiplier on it, so every stop stays in proportion and the
   curve's shape is preserved at any width. Expressed against a CSS variable
   rather than baked into the string, because the layer keys its style
   injection on the stylesheet: a width that changed this text would tear the
   <style> element down and rebuild it on every frame of a slider drag. */
const REFERENCE_WIDTH = 80;
const at = (px) => (px === 0 ? "0px" : `calc(var(--rim-width) * ${px / REFERENCE_WIDTH})`);

/* One axis of the mask: strongest at both edges, transparent through the
   middle. Lengths throughout -- no percentage/aspect-ratio reinterpretation
   like the earlier failed radial-gradient attempts. */
function edgeMask(direction) {
  const stops = [
    ...FALLOFF.map(([px, alpha]) => `rgba(0, 0, 0, ${alpha}) ${at(px)}`),
    ...[...FALLOFF].reverse().map(([px, alpha]) => `rgba(0, 0, 0, ${alpha}) calc(100% - ${at(px)})`),
  ];
  return `linear-gradient(to ${direction}, ${stops.join(", ")})`;
}

/**
 * An opaque plane with a soft hole punched at one inner corner, multiplied
 * into the rim by `mask-composite: intersect`.
 *
 * The two edge masks union into a *square* inner corner: the glow runs the
 * full band width along both edges right up to the point where they meet,
 * at (width, width) in from the screen corner. Rounding that off means
 * taking glow away around that point, so each layer here is transparent at
 * that point and back to fully opaque by `--rim-corner`.
 *
 * Punching a hole and intersecting, rather than drawing a disc and
 * subtracting: `mask-composite: subtract` is source-OUT, i.e. *source minus
 * destination*, not destination minus source. A disc composited that way
 * replaces the rim with "disc outside rim" and, at radius 0, wipes the rim
 * off the screen entirely.
 *
 * The ending shape is a fixed 100vmax with the *stops* carrying the radius,
 * rather than sizing the circle by the variable, so that radius 0 degrades
 * safely: the stops collapse onto the centre point, everything past it takes
 * the last colour -- opaque -- and the layer multiplies through as a no-op.
 * That's what makes 0 a safe default rather than a special case.
 */
function cornerHole(x, y) {
  return (
    `radial-gradient(circle 100vmax at ${x} ${y}, ` +
    "rgba(0, 0, 0, 0) 0px, " +
    "rgba(0, 0, 0, 0.5) calc(var(--rim-carve) * 0.55), " +
    "rgba(0, 0, 0, 1) var(--rim-carve))"
  );
}

/**
 * The other direction: a bloom centred on the *screen* corner, unioned in
 * with `add`, so the rim reaches further into the page there instead of
 * being cut back.
 *
 * Same FALLOFF curve as the edges, in radial form, scaled to `--rim-bulge`.
 * Scaled to the bulge alone and not to `width + bulge`, so that a bulge of 0
 * collapses every stop onto the centre and the last colour -- transparent --
 * takes the whole plane, making the layer a no-op that `add` unions in for
 * free. Anchoring it at `width + bulge` instead would leave a quarter-disc
 * of glow sitting at each corner at the default, which is exactly the thing
 * a signed control has to avoid: 0 must mean *untouched*.
 *
 * The consequence to know about: the square corner already reaches
 * width * sqrt(2) along the diagonal, so a bulge only starts changing the
 * *shape* once it passes that (~113px at the default width). Below it the
 * bloom sits inside the existing band and just fills the corner in.
 */
function cornerBloom(x, y) {
  const stops = FALLOFF.map(
    ([px, alpha]) =>
      `rgba(0, 0, 0, ${alpha}) ${px === 0 ? "0px" : `calc(var(--rim-bulge) * ${px / REFERENCE_WIDTH})`}`,
  );
  return `radial-gradient(circle 100vmax at ${x} ${y}, ${stops.join(", ")})`;
}

const NEAR = "var(--rim-width)";
const FAR = "calc(100% - var(--rim-width))";
const CORNERS = [
  ["0px", "0px"],
  ["100%", "0px"],
  ["0px", "100%"],
  ["100%", "100%"],
];

const HOLES = [cornerHole(NEAR, NEAR), cornerHole(FAR, NEAR), cornerHole(NEAR, FAR), cornerHole(FAR, FAR)];
const BLOOMS = CORNERS.map(([x, y]) => cornerBloom(x, y));

/* Scoped inside the overlay's shadow root, so these class names are ours
   alone and can't collide with the host app's.

   The horizontal and vertical masks are unioned with `mask-composite: add`,
   which is source-over -- 1-(1-x)(1-y), not saturating addition. That
   matters at the corners: it lands them at 1-(1-0.53)^2 = 0.78, which is
   what the original's separable 2D blur gives there too (0.47 x 0.47
   covered). Corners come out brighter than the edges in both, by the same
   amount, without clipping.

   Layers composite bottom-up while the list reads top-first: the two edge
   masks (last) union into the square-cornered rim, and the corner layers
   shape it from there.

   `-webkit-mask-composite` is a different keyword set and is deliberately
   not emitted: on an engine too old for the standard property every layer
   just unions, which loses the corner shaping and keeps everything else. */

/**
 * Three masks, one per sign of `cornerRadius`, and only the layers that sign
 * actually uses.
 *
 * The holes and the blooms are the two sides of one control, so one of them is
 * always sitting at its no-op -- and a no-op mask layer is free to *write* and
 * expensive to *run*. Every frame the rim moves, the browser recomposites the
 * whole mask stack over the viewport, no-ops included.
 *
 * Measured on this machine at 1440x900, rim on, nothing else animating:
 *
 *     10 layers (holes + blooms + edges)    21 fps
 *      6 layers (one side + edges)          28 fps
 *      2 layers (edges only)                40 fps
 *
 * -- roughly linear in the layer count, and at the default cornerRadius of 0
 * EIGHT of the ten were identity operations. That is where the rim's stutter
 * was coming from: not the colour, not the gradient (unmasked, the same
 * animation holds a flat 60), but repainting under a mask stack eight layers
 * of which did nothing.
 *
 * The output is identical for every setting. At carve 0 each hole's stops all
 * collapse to 0px and the layer is opaque everywhere past a single point; at
 * bulge 0 each bloom collapses to fully transparent. Dropping a layer that
 * multiplies by 1, or unions in nothing, changes no pixel.
 *
 * Written as three static classes rather than a computed stylesheet because
 * the layer keys its <style> injection on the CSS text: making this depend on
 * a prop would tear the element down and rebuild it as the slider crossed 0.
 */
const EDGES = [edgeMask("right"), edgeMask("bottom")];
const MASKS = {
  // cornerRadius === 0: the square inner corner the two edge masks produce.
  square: { layers: EDGES, composite: "add, add" },
  // cornerRadius > 0: cut the inner corner back.
  carve: { layers: [...HOLES, ...EDGES], composite: "intersect, intersect, intersect, intersect, add, add" },
  // cornerRadius < 0: bloom it outward.
  bulge: { layers: [...BLOOMS, ...EDGES], composite: "add, add, add, add, add, add" },
};

/**
 * Clips the rim to the band it actually occupies, so the browser stops
 * rasterising and masking the empty middle of the screen.
 *
 * The frame is viewport-sized, but FALLOFF reaches alpha 0 at exactly
 * `--rim-width` -- everything inside that is transparent already. Clipping it
 * away removes no pixel and takes roughly two thirds of the masked area with
 * it. Measured: p95 frame time 24.6ms -> 19.2ms, which is the 60fps floor.
 *
 * `polygon()` is ONE closed path and has no way to declare a second subpath,
 * so the hole is cut the way SVG does it: walk the outer rectangle clockwise,
 * return to the start, then walk the inner one counter-clockwise. Opposite
 * winding is what makes the nonzero rule treat the inner rectangle as a hole;
 * listing the two rectangles as eight points and asking for `evenodd` instead
 * builds a self-intersecting octagon, which clipped away most of the left and
 * right bands. The outer rectangle sits 2px OUTSIDE the
 * element: a clip edge is antialiased, and along the screen edge the rim is at
 * its brightest, so a boundary drawn exactly at 0% cut that column's coverage
 * roughly in half and left a dark 1px outline around the whole viewport --
 * measured at a channel delta of 78. Nothing is painted out there anyway, so
 * moving the seam off the element removes it. The INNER edge needs no such
 * treatment: the mask is already at alpha 0 where it falls.
 *
 * NOT applied to the bulge variant: that is the one setting where glow
 * deliberately reaches past `--rim-width`, into the corners, and this would
 * cut it off.
 */
const RING_CLIP =
  "polygon(" +
  // Outer, clockwise, 2px outside the element.
  "-2px -2px, calc(100% + 2px) -2px, calc(100% + 2px) calc(100% + 2px), -2px calc(100% + 2px), -2px -2px, " +
  // Inner, counter-clockwise, so the nonzero rule reads it as a hole.
  "var(--rim-width) var(--rim-width), var(--rim-width) calc(100% - var(--rim-width)), " +
  "calc(100% - var(--rim-width)) calc(100% - var(--rim-width)), calc(100% - var(--rim-width)) var(--rim-width), " +
  "var(--rim-width) var(--rim-width))";

const maskRule = (name) => {
  const { layers, composite } = MASKS[name];
  const image = layers.join(", ");
  return `
  .frame.${name} {
    -webkit-mask-image: ${image};
    mask-image: ${image};
    mask-composite: ${composite};${name === "bulge" ? "" : `
    clip-path: ${RING_CLIP};`}
  }`;
};

const GLOW_CSS = `
  .frame {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
  }
${Object.keys(MASKS).map(maskRule).join("\n")}

  /* Viewport-sized, exactly like the original's \`absolute size-full\`. The
     sweep is the gradient's angle animating 0->360deg, not a rotating
     plane: at every moment all four colors are mapped across the screen
     along the current axis, which is what gives each edge its spread of
     color instead of one stretched-out band. */
  .sweep {
    position: absolute;
    inset: 0;
  }
`;

/**
 * Geometry, both in px:
 *
 *   `width` -- how far the rim reaches inward before it's fully gone. Scales
 *      the whole FALLOFF curve proportionally, so the shape of the decay is
 *      the same at any width; 80 is the reference's Gaussian extent.
 *   `cornerRadius` -- signed shaping of the *inner* corner, where the glow
 *      turns to follow the next edge. 0 leaves the square corner the two
 *      edge masks produce naturally, which is the reference's own shape.
 *      Positive cuts that corner back towards the screen corner, so the rim
 *      thins there. Negative blooms it the other way, reaching further into
 *      the page. Either way the *outer* corner stays square, hard against
 *      the screen.
 *
 * The sign is split here into two one-sided lengths, because a mask layer
 * has no notion of a negative radius: each side has its own family of
 * layers, and the inactive one sits at 0, where it's a no-op.
 */
/**
 * `state` picks the palette: ready, listening, working, speaking.
 *
 * Two motion values rather than a keyframe array on `background`. The angle
 * has to keep turning at a constant rate while the colour crosses, and
 * animating one `background` property for both would restart the rotation
 * every time the state changed.
 *
 *   angle  0 to 360, linear, forever -- the sweep
 *   mix    0 to 1 -- how far from the previous palette to the current one
 *
 * The crossfade is interrupt-safe, which matters because these states change
 * faster than the fade: listening to working to speaking can all land inside a
 * second. Rather than always mixing between two fixed palettes, it snapshots
 * whatever is ON SCREEN when a change arrives and treats that as the new
 * origin. Interrupting a half-finished fade therefore continues from the
 * colour actually showing, instead of snapping back to a palette the user
 * never fully saw.
 */
export function ListeningGlow({
  active,
  state = "listening",
  width = 80,
  cornerRadius = 0,
  palettes = PALETTES,
  rotationMs = 5000,
  /**
   * How long a change of state takes to reach the eye.
   *
   * 700ms measured as abrupt in use, and the duration was only half of why.
   * The other half was easeInOut, which is right for something moving -- you
   * track the object, so acceleration reads as weight -- and wrong for a
   * colour, which has no trajectory to follow. All you see is the middle
   * burst: with easeInOut, 11% of the change happened in the first 180ms and
   * 65% in the middle 360ms, which lands as a pause, a snap, and a pause.
   */
  crossfadeMs = 1200,
  /**
   * OKLCh: equal steps are equally visible AND the path stays on the outside
   * of the hue wheel. OKLab alone fixed the pace and left the route: between
   * two near-opposite hues its straight line is a chord through the neutral
   * axis, so the rim desaturated to near-grey halfway and, at 53% alpha over a
   * light page, all but disappeared before coming back as the new colour. See
   * palettes.js for the measured chroma collapse.
   */
  space = "oklch",
}) {
  const angle = useMotionValue(0);
  // How far along the current crossfade we are: 0 at the moment the state
  // changed, 1 once it has settled.
  const mix = useMotionValue(1);

  // Read inside the per-frame transform, so a palette edited in the tuner or a
  // colour space toggled shows up immediately without restarting the fade.
  // Palettes and space only. `state` deliberately does NOT live here -- see
  // `fadingTo` below for the frame of wrong colour that put it there.
  const live = useRef({ palettes, space });
  live.current = { palettes, space };

  // Where the crossfade started FROM: the actual colours on screen when the
  // state last changed, not a palette. Interrupting a half-finished fade then
  // continues from what the user can see rather than snapping back to a
  // palette they never fully saw -- and these states change faster than the
  // fade, since listening, working and speaking can all land inside a second.
  const fromRef = useRef(palettes[state] ?? PALETTES.listening);

  /**
   * Which state the fade is heading FOR, and the reason it is a ref set in the
   * effect rather than the `state` prop read straight off.
   *
   * `background` recomputes on framer's frame loop, and it needs three things
   * to agree: where the fade started, where it is going, and how far along it
   * is. Two of those are set in the effect. Reading the third from a value
   * assigned during RENDER breaks the agreement for exactly as long as it
   * takes the effect to run -- and in that window `mix` is still 1 from the
   * fade that just finished, so `mix(oldOrigin, NEW target, 1)` paints the
   * destination palette at full strength. One frame of prism in the middle of
   * a violet rim, then a snap back to violet as the effect resets `mix` to 0
   * and the real fade begins. Measured at 68x the fade's own per-frame
   * movement.
   *
   * It only shows when the change did NOT come from a click. React flushes
   * passive effects synchronously for discrete input, so pressing a button in
   * the tuner never reproduced it -- which is why every measurement said the
   * fade was even while the app plainly was not. A data channel message is not
   * discrete input, and that is every state change in a real session.
   *
   * Setting it here, beside `fromRef` and `mix`, means the three cannot
   * disagree: until the effect runs they describe the finished previous fade,
   * which is the colour already on screen, and after it they describe the new
   * one. No ordering assumption, no layout effect, nothing to get wrong again.
   */
  const fadingTo = useRef(state);

  useEffect(() => {
    if (!active) return;
    const controls = animate(angle, 360, {
      duration: rotationMs / 1000,
      ease: "linear",
      repeat: Infinity,
      repeatType: "loop",
    });
    return () => controls.stop();
  }, [active, angle, rotationMs]);

  useEffect(() => {
    const { palettes: p, space: sp } = live.current;
    const leaving = p[fadingTo.current] ?? PALETTES.listening;
    fromRef.current = mixPalettes(fromRef.current, leaving, mix.get(), sp);
    fadingTo.current = state;
    mix.set(0);
    // Linear, so every moment of the fade carries the same amount of change.
    // A colour has no inertia to simulate, and evenness is what reads as
    // "moving" rather than "switching".
    const controls = animate(mix, 1, { duration: crossfadeMs / 1000, ease: "linear" });
    return () => controls.stop();
  }, [state, crossfadeMs, mix]);

  const background = useTransform([angle, mix], ([a, m]) => {
    const { palettes: p, space: sp } = live.current;
    return rimGradient(a, mixPalettes(fromRef.current, p[fadingTo.current] ?? PALETTES.listening, m, sp));
  });

  return (
    <OverlayLayer name="rim" css={GLOW_CSS} active={active}>
      <AnimatePresence>
        {active && (
          <motion.div
            className={`frame ${cornerRadius === 0 ? "square" : cornerRadius > 0 ? "carve" : "bulge"}`}
            style={{
              "--rim-width": `${width}px`,
              "--rim-carve": `${Math.max(0, cornerRadius)}px`,
              "--rim-bulge": `${Math.max(0, -cornerRadius)}px`,
            }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: "easeInOut" }}
          >
            <motion.div className="sweep" style={{ background }} />
          </motion.div>
        )}
      </AnimatePresence>
    </OverlayLayer>
  );
}
