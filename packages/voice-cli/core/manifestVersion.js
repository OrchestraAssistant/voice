/**
 * Manifest versioning -- two separate numbers, because they answer two
 * different questions.
 *
 *  - `version` (format version): bumped only when the manifest's SHAPE changes
 *    (a new field the runtime must read, a renamed key). The runtime compares
 *    it to warn/refuse on a manifest produced by an incompatible CLI. An app
 *    changing its own operations does NOT move it.
 *
 *  - `contractHash`: a hash over ONLY the callable surface -- the fields that,
 *    if they drift from the running app, make a voice call fail or mis-gate.
 *    This is the staleness signal: a CI check regenerates and compares it, so a
 *    manifest that no longer matches its source is caught before it ships.
 *
 * The split is the whole point: re-wording a description or re-grouping the
 * catalog changes the file but not the contractHash, so it is not "stale";
 * renaming an operation, moving an endpoint, or flipping a confirmation tier
 * does change it. What goes into `projectContract` IS that relevant/superfluous
 * line, written down.
 */
import { createHash } from "node:crypto";

export const MANIFEST_FORMAT_VERSION = 1;

const byKey = (a, b) =>
  String(a.name ?? a.path ?? a.id ?? "").localeCompare(String(b.name ?? b.path ?? b.id ?? ""));

const param = (p) => ({
  name: p?.name,
  type: p?.type ?? null,
  required: !!p?.required,
  source: p?.source ?? null,
});

/**
 * The callable surface. IN: names, methods, endpoints, transports, param and
 * body shapes (name/type/required), route paths, confirmation tiers, agent ids
 * and their transport wiring. OUT (not hashed): descriptions, grouping/expand
 * layout, callSite counts, `returns`, the generator stamp, key order, spacing.
 */
export function projectContract(manifest) {
  const m = manifest || {};
  const op = (o) => ({
    name: o.name,
    method: o.method ?? null,
    endpoint: o.endpoint ?? null,
    transport: o.transport ?? null,
    params: (o.params ?? []).map(param).sort(byKey),
  });
  return {
    routes: (m.routes ?? []).map((r) => ({ path: r.path })).sort((a, b) => String(a.path).localeCompare(String(b.path))),
    queries: (m.queries ?? []).map(op).sort(byKey),
    actions: (m.actions ?? [])
      .map((a) => ({
        ...op(a),
        requiresConfirmation: !!a.requiresConfirmation,
        bodyFields: (a.bodyFields ?? [])
          .map((f) => ({ name: f.name, type: f.type ?? null, required: !!f.required }))
          .sort(byKey),
      }))
      .sort(byKey),
    agents: (m.agents ?? [])
      .map((g) => ({
        id: g.id,
        transport: g.transport ?? null,
        ui: g.ui
          ? { input: g.ui.input ?? null, send: g.ui.send ?? null, transcript: g.ui.transcript ?? null, done: g.ui.done ?? null }
          : null,
        api: g.api ? { endpoint: g.api.endpoint ?? null, method: g.api.method ?? null } : null,
      }))
      .sort(byKey),
  };
}

/** Stable stringify: sorted keys, so object key order never moves the hash. */
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  }
  return JSON.stringify(value ?? null);
}

export function contractHash(manifest) {
  return createHash("sha256").update(canonical(projectContract(manifest))).digest("hex").slice(0, 16);
}

/**
 * Return the manifest with `version` and `contractHash` stamped at the top.
 * Idempotent: prior stamp fields are dropped before hashing (the projection
 * ignores them anyway), so stamping twice yields the same result.
 */
export function stampVersion(manifest) {
  const { version: _v, contractHash: _h, ...rest } = manifest || {};
  return { version: MANIFEST_FORMAT_VERSION, contractHash: contractHash(rest), ...rest };
}

/** Human-readable operation identifiers, for a stale-vs-fresh diff. */
export function contractKeys(manifest) {
  const m = manifest || {};
  return [
    ...(m.routes ?? []).map((r) => `route ${r.path}`),
    ...(m.queries ?? []).map((q) => `query ${q.name}`),
    ...(m.actions ?? []).map((a) => `action ${a.name}`),
    ...(m.agents ?? []).map((g) => `agent ${g.id}`),
  ];
}

export function contractDiff(oldManifest, newManifest) {
  const o = new Set(contractKeys(oldManifest));
  const n = new Set(contractKeys(newManifest));
  return {
    added: [...n].filter((k) => !o.has(k)),
    removed: [...o].filter((k) => !n.has(k)),
  };
}
