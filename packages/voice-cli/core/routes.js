/**
 * Matching a concrete path against a route pattern.
 *
 * The manifest writes a parameter as `:schedule` or `[schedule]`, depending on
 * which router the app uses, and both mean "one segment, any value". A route
 * with parameters cannot be visited without a real value, and inventing one
 * probes a 404 -- so the way to get one is to let the app hand it over, from a
 * link on a page that has already been visited.
 *
 * Segment-wise, never a prefix: `/availability` must not satisfy a pattern
 * written for `/availability/:schedule`, which is a different screen with
 * different controls.
 */
// `:x` / `[x]` (incl. `[...x]`) are params; `*` and `$` are catch-all splats that
// route producers emit (next/routes.js, tanstack). Without the splats a catch-all
// like `/docs/*` read as a CONCRETE path, so readiness probed the literal URL
// `/docs/*` -- and this disagreed with core/probe.js, which already skips them.
const PARAM = /^(:.+|\[.+\]|\*|\$)$/;

export function isPattern(path) {
  return String(path).split("/").some((segment) => PARAM.test(segment));
}

export function matchesPattern(pattern, path) {
  const want = String(pattern).split("/").filter(Boolean);
  const have = String(path).split("/").filter(Boolean);
  if (want.length !== have.length) return false;
  return want.every((segment, i) => PARAM.test(segment) || segment === have[i]);
}

/** How many segments a pattern spells out, so the most specific one wins. */
function specificity(pattern) {
  return String(pattern).split("/").filter((seg) => seg && !PARAM.test(seg)).length;
}

/**
 * One concrete path per parameterised route, taken from links the app itself
 * rendered.
 *
 * Two rules keep a greedy pattern from swallowing the app. A path that IS a
 * route in its own right is never an instance of a pattern -- cal.diy has a
 * literal `/event-types` and a catch-all `/:user`, and without this the
 * catch-all claimed it. And where several patterns still match, the one
 * spelling out the most segments wins, so `/bookings/upcoming` belongs to
 * `/bookings/:status` rather than to `/:user/:type`.
 *
 * The first match wins and the rest are ignored: a list page offers dozens of
 * instances and measuring one is the point. Which one is arbitrary, and that
 * is a real limit -- a schedule with no overrides may render a control a
 * busier one does not -- so a marker that looks like data rather than
 * structure deserves suspicion.
 */
export function instancesFor(patterns, hrefs, { reserved = [] } = {}) {
  const taken = new Set(reserved.map((path) => String(path).split("?")[0]));
  const ranked = [...patterns].sort((a, b) => specificity(b) - specificity(a));
  const found = new Map();

  for (const href of hrefs) {
    const path = String(href).split("?")[0];
    if (taken.has(path)) continue; // the app has a real route for this
    const owner = ranked.find((pattern) => matchesPattern(pattern, path));
    if (owner && !found.has(owner)) found.set(owner, path);
  }
  return found;
}
