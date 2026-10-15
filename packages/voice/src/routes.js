/**
 * Work out which route the model meant.
 *
 * It does not reliably send `{ path: "/settings" }`. Observed live, four of
 * five navigate calls in one session arrived as `{"/": "settings"}` and
 * `{"/": "dashboard"}` -- the route in the KEY, the schema ignored. Every one
 * failed with "Cannot read properties of undefined (reading 'pathname')", the
 * model retried the identical malformed call three times, and it eventually
 * told the user to refresh the page.
 *
 * The schema already says `path` is required and the API did not enforce it,
 * so being strict here buys nothing a user would thank us for. Navigation is
 * not destructive: the worst case is landing on the wrong page, which the next
 * sentence fixes. So read the intent out of whatever arrived.
 *
 * Deliberately NOT applied to actions. Guessing what someone meant is fine for
 * a hyperlink and not fine for a delete.
 */
export function resolveRoutePath(args, routes = []) {
  const known = routes.filter((r) => typeof r?.path === "string");

  // `path` first when it is there, then every other string in the object --
  // values before keys, since `{"/": "settings"}` carries the useful half in
  // the value and a bare "/" in the key would otherwise win.
  const candidates = [];
  if (typeof args?.path === "string") candidates.push(args.path);
  for (const value of Object.values(args ?? {})) if (typeof value === "string") candidates.push(value);
  for (const key of Object.keys(args ?? {})) if (key !== "path") candidates.push(key);

  for (const raw of candidates) {
    const text = raw.trim();
    if (!text) continue;
    const asPath = text.startsWith("/") ? text : `/${text}`;

    // An exact route.
    if (known.some((r) => r.path === asPath)) return asPath;

    // A component name: "dashboard" is the route named Dashboard, which is
    // "/" and would never be found by string matching on the path.
    const bare = text.replace(/^\//, "").toLowerCase();
    const byComponent = known.find((r) => r.component?.toLowerCase() === bare);
    if (byComponent) return byComponent.path;

    // Something path-shaped we do not recognise: a parameterised route like
    // /tasks/3 is legitimate and will not be in the list literally.
    if (text.startsWith("/")) return text;
  }
  return null;
}

/** Non-empty path segments, so a trailing slash (Plane uses them) is ignored. */
const segments = (p) => String(p ?? "").split("/").filter(Boolean);

/** The param NAMES in a route pattern: /:workspaceSlug/projects/:projectId -> ["workspaceSlug","projectId"]. */
export function routeParams(pattern) {
  return segments(pattern).filter((s) => s.startsWith(":")).map((s) => s.slice(1));
}

/**
 * Bind a concrete pathname to a route PATTERN, returning the param values it
 * carries, or null if it does not match. `/:workspaceSlug` against
 * `/field-test/` yields `{ workspaceSlug: "field-test" }`.
 *
 * Catch-all patterns are refused (they match everything and bind nothing, which
 * would wrongly satisfy the search below); we only mine real, fully-segmented
 * routes for the params the user is already standing in.
 */
export function matchPattern(pattern, pathname) {
  const ps = segments(pattern);
  if (ps.includes("*")) return null;
  const xs = segments(pathname);
  if (ps.length !== xs.length) return null;
  const out = {};
  for (let i = 0; i < ps.length; i++) {
    if (ps[i].startsWith(":")) out[ps[i].slice(1)] = decodeURIComponent(xs[i]);
    else if (ps[i] !== xs[i]) return null;
  }
  return out;
}

/** Fill a pattern from a bag of values. Returns { path, missing } -- missing lists the holes left open. */
export function fillPattern(pattern, values = {}) {
  const missing = [];
  const path = segments(pattern)
    .map((s) => {
      if (!s.startsWith(":")) return s;
      const name = s.slice(1);
      const value = values[name];
      if (value == null || value === "") {
        missing.push(name);
        return s;
      }
      return encodeURIComponent(value);
    })
    .join("/");
  return { path: "/" + path, missing };
}

/** The param values a model handed us, whether spread across args or nested in `params`. */
function argValues(args) {
  const out = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (key === "path") continue;
    if (key === "params" && value && typeof value === "object") Object.assign(out, value);
    else if (typeof value === "string" || typeof value === "number") out[key] = value;
  }
  return out;
}

/** The params the CURRENT url already binds -- the slug/org the user is looking at. */
function currentParams(routes, currentPath) {
  for (const route of routes) {
    if (typeof route?.path !== "string") continue;
    const bound = matchPattern(route.path, currentPath);
    if (bound) return bound;
  }
  return {};
}

/**
 * Plan a navigation: pick the target route, then FILL its `:params` before
 * anyone hands a pattern to the router.
 *
 * The values come from two places, args winning: what the model passed (a
 * `projectId` it just resolved), and what the current url already binds -- the
 * `workspaceSlug` the user is standing in, reused for free so the model never
 * has to know it. A param that neither source fills is a hole, and a path with
 * a hole is refused rather than navigated: sending `/:workspaceSlug/projects`
 * to the router lands on the app's not-found, which is exactly the "went
 * somewhere completely different" failure. Refusing lets the caller tell the
 * model what to resolve (or ask the user) instead.
 *
 * Returns one of: { path } ready to navigate, { missing, pattern } to refuse
 * with, or { error: true } when no route could be identified at all.
 */
export function planNavigation(args, routes = [], currentPath = "") {
  const target = resolveRoutePath(args, routes);
  if (!target) return { error: true };

  if (!routeParams(target).length) return { path: target }; // a flat route -- nothing to fill

  const values = { ...currentParams(routes, currentPath), ...argValues(args) };
  const { path, missing } = fillPattern(target, values);
  return missing.length ? { pattern: target, missing } : { path };
}
