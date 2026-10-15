/**
 * Read-back verification: did a write actually CHANGE anything?
 *
 * The requiredFields probe reads a STATUS -- a write that omits a field and is
 * rejected proves the field required. But a status lies when a handler answers
 * 200 and does nothing. cal.diy's schedule.update is exactly this: its schema
 * marks `name` optional, and a call without `name` returns 200 with the
 * unchanged schedule, because the handler does `if (!input.name) return` before
 * it writes. Every status-based check calls that a success. Only reading the
 * state back afterwards catches it.
 *
 * The hard truth this stage is built around: you cannot SYNTHESISE the payload
 * to test with. To know a payload that works is to already know the contract,
 * which is the very thing a silent no-op hides -- the check would send the same
 * broken payload and conclude the endpoint is fine. So the payload comes from
 * OUTSIDE: a fixture written by whoever runs the probe, holding the natural call
 * a person or model would make. The stage's whole job is to send that call for
 * real and report whether the world moved. A fixture that turns out to be a
 * silent no-op is the finding, not a failure of the probe.
 *
 * Pure here; the request is performed by the stage. Building the request the
 * same way the widget's transport does -- superjson envelope, date tagging --
 * is what makes the probe test the wire the widget will actually send, so it
 * mirrors packages/voice/src/transports.js deliberately. If the two ever drift,
 * that file is the source of truth; a shared package is the real fix.
 */

/** superjson's `{ json, meta }`, Dates only -- see transports.js for the why. */
export function superjsonSerialize(value) {
  const meta = {};
  const walk = (v, path) => {
    if (v instanceof Date) {
      meta[path.join(".")] = ["Date"];
      return v.toISOString();
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, [...path, i]));
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k], [...path, k]);
      return out;
    }
    return v;
  };
  const json = walk(value, []);
  return Object.keys(meta).length ? { json, meta: { values: meta } } : { json };
}

/** Coerce declared date fields (strings) to Date so superjson can tag them. */
function coerceAtPath(value, path) {
  if (Array.isArray(value)) return value.map((v) => coerceAtPath(v, path));
  if (path.length === 0) {
    if (value == null || value instanceof Date) return value;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d;
  }
  if (value && typeof value === "object") {
    const [key, ...rest] = path;
    if (key in value) return { ...value, [key]: coerceAtPath(value[key], rest) };
  }
  return value;
}

export function coerceDeclaredDates(args, fields) {
  let out = args;
  for (const field of fields ?? []) {
    if (!field.dates?.length || !out || !(field.name in out)) continue;
    let value = out[field.name];
    for (const path of field.dates) value = coerceAtPath(value, path);
    out = { ...out, [field.name]: value };
  }
  return out;
}

const buildUrl = (template, args) => {
  let url = template;
  for (const [key, value] of Object.entries(args ?? {})) {
    url = url.replace(`{${key}}`, encodeURIComponent(value));
  }
  return url;
};

/**
 * How the widget would send this operation: `{ method, url, body }`. tRPC gets
 * the superjson envelope (with date tags); REST gets a plain body of declared
 * fields. Enough of transports.js to be faithful, and no more.
 */
export function encodeOperation(operation, args = {}) {
  const declared = [...(operation.params ?? []), ...(operation.bodyFields ?? [])];

  if (operation.transport === "trpc") {
    const input = superjsonSerialize(coerceDeclaredDates(args ?? {}, declared));
    if (operation.method === "GET") {
      const url = buildUrl(operation.endpoint, args);
      return { method: "GET", url: `${url}?input=${encodeURIComponent(JSON.stringify(input))}` };
    }
    return { method: operation.method ?? "POST", url: buildUrl(operation.endpoint, args), body: input };
  }

  // REST.
  const url = buildUrl(operation.endpoint, args);
  if ((operation.method ?? "GET") === "GET") {
    const query = (operation.params ?? [])
      .filter((p) => p.source === "query-string" && args[p.name] != null)
      .map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(args[p.name])}`)
      .join("&");
    return { method: "GET", url: query ? `${url}?${query}` : url };
  }
  const allowed = new Set((operation.bodyFields ?? []).map((f) => f.name));
  const body = Object.fromEntries(Object.entries(args).filter(([k, v]) => allowed.has(k) && v !== undefined));
  return { method: operation.method, url, body: Object.keys(body).length ? body : undefined };
}

/** Unwrap a tRPC reply to its payload; leave a REST reply as-is. */
export function unwrapReply(body) {
  const data = body?.result?.data;
  if (data && typeof data === "object" && "json" in data) return data.json;
  return body;
}

/** A value at a dot/index path, e.g. `schedules.0.availability.0.days`. */
export function at(value, path) {
  if (!path) return value;
  return String(path)
    .split(".")
    .reduce((v, key) => (v == null ? v : v[key]), value);
}

/**
 * What the before/after pair proved.
 *
 * A 4xx is the write being REJECTED -- the requiredFields story, not this one.
 * A 2xx that moved the observed value is a real effect: the operation is
 * verified. A 2xx that moved nothing is the silent no-op, and the whole reason
 * the stage exists.
 */
export function classifyEffect({ status, before, after }) {
  if (status == null || status === 0) return { outcome: "unreachable", note: "no response" };
  if (status >= 400) return { outcome: "rejected", note: `write returned ${status}` };
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (changed) return { outcome: "verified", note: "state changed" };
  return { outcome: "silent-noop", note: `returned ${status} but the observed value did not change` };
}
