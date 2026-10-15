/**
 * Combines what every detector found into one manifest.
 *
 * Union rather than first-wins, because detectors see different things: an app
 * migrating between Next.js routers genuinely has both, and a codebase can
 * declare some routes in JSX and others in the filesystem.
 *
 * Disagreements are recorded rather than resolved. Two detectors describing
 * the same operation differently means either the app is inconsistent or our
 * reading of it is wrong, and both are worth a human's attention -- silently
 * picking one is how a manifest ends up quietly describing something that is
 * not there.
 */
export function merge(results) {
  const manifest = { routes: [], queries: [], actions: [] };
  const conflicts = [];
  const notes = [];
  const sources = {};

  for (const { detector, found } of results) {
    for (const kind of ["routes", "queries", "actions"]) {
      for (const item of found[kind] ?? []) {
        const key = kind === "routes" ? item.path : item.name;
        const existing = manifest[kind].find((i) => (kind === "routes" ? i.path : i.name) === key);
        if (!existing) {
          manifest[kind].push(item);
          sources[`${kind}:${key}`] = [detector];
          continue;
        }
        sources[`${kind}:${key}`].push(detector);
        const differences = disagreements(existing, item);
        if (differences.length) {
          conflicts.push({ kind, key, between: sources[`${kind}:${key}`], differences });
        }
      }
    }
  }
  return { manifest, conflicts, notes, sources };
}

/** Fields where two readings of the same thing genuinely contradict. */
function disagreements(a, b) {
  const out = [];
  for (const field of ["method", "endpoint", "requiresConfirmation", "component"]) {
    if (a[field] !== undefined && b[field] !== undefined && a[field] !== b[field]) {
      out.push(`${field}: ${JSON.stringify(a[field])} vs ${JSON.stringify(b[field])}`);
    }
  }
  const names = (x) => (x ?? []).map((p) => p.name).sort().join(",");
  for (const field of ["params", "bodyFields"]) {
    if (a[field] && b[field] && names(a[field]) !== names(b[field])) {
      out.push(`${field}: [${names(a[field])}] vs [${names(b[field])}]`);
    }
  }
  return out;
}
