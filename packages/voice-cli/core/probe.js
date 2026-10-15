/**
 * Checking the manifest against the running app.
 *
 * Static analysis reads structure, and structure is not behaviour. It can see
 * that a route file exists and that a schema marks a field optional; it cannot
 * see that the route redirects, that the endpoint moved, or that the server
 * rejects the request without a field the schema calls optional. Only asking
 * the app settles those.
 *
 * Probing also DISCOVERS things static analysis cannot express at all. The
 * manifest has no way to say what a query returns, and the agent has to guess
 * from the name. One call answers it.
 *
 * Pure here, performed by probe.js. Deciding what to ask and reading the
 * answer is the part worth testing; making an HTTP request is not.
 */

/** A route with a parameter cannot be visited without inventing a value, and
 *  an invented id is a 404 that means nothing about the manifest. */
export const isProbeableRoute = (route) => !/[:{*]/.test(route.path);

/**
 * What to ask of each route and query.
 *
 * Actions are absent on purpose. Probing a write means performing one, and
 * that is a decision the caller makes explicitly rather than a default.
 */
export function readOnlyPlan(manifest) {
  const plan = [];
  for (const route of manifest.routes ?? []) {
    if (!isProbeableRoute(route)) {
      plan.push({ kind: "route", name: route.path, skipped: "has a parameter; no value to put in it" });
      continue;
    }
    plan.push({ kind: "route", name: route.path, method: "GET", url: route.path });
  }
  for (const query of manifest.queries ?? []) {
    const needed = (query.params ?? []).filter((p) => p.required && p.source === "url");
    // The endpoint itself is the authority, not just the `source` label. A
    // `{param}` still in the template is an unfilled path parameter that no
    // request can satisfy, whatever the param was TAGGED -- fetching it
    // literally 404s on the braces. Trusting `source` alone made a manifest with
    // a mislabelled param (e.g. "path" instead of "url", easy to write by hand
    // or emit from a new producer) sail past this filter and report a dozen live
    // endpoints as missing. Routes are already hardened this way (isProbeableRoute);
    // this brings queries level.
    const placeholders = (query.endpoint?.match(/\{([^}]+)\}/g) ?? []).map((s) => s.slice(1, -1));
    const unfilled = [...new Set([...needed.map((p) => p.name), ...placeholders])];
    if (unfilled.length) {
      plan.push({ kind: "query", name: query.name, skipped: `needs ${unfilled.join(", ")}` });
      continue;
    }
    plan.push({ kind: "query", name: query.name, method: "GET", url: query.endpoint, operation: query });
  }
  return plan;
}

/**
 * Whether a page answered.
 *
 * A redirect is not a failure: plenty of real routes bounce to a canonical
 * path or to a login page, and following it would only prove that the app has
 * authentication. What matters is that the path is KNOWN -- a 404 means the
 * agent has been told about a page that is not there, and will send someone to
 * it with confidence.
 */
export function readRoute(status) {
  if (status === 404 || status === 410) return { ok: false, why: `the page is not there (${status})` };
  if (status >= 500) return { ok: false, why: `the page errors (${status})` };
  if (status === 401 || status === 403) return { ok: true, note: "exists, behind authentication" };
  if (status >= 300 && status < 400) return { ok: true, note: "redirects" };
  return { ok: true };
}

/**
 * A compact description of what a query returns.
 *
 * The manifest cannot say this today, so the model infers it from the tool
 * name and whatever comes back at runtime. Naming the fields costs a dozen
 * tokens and removes the guess. Deliberately shallow: a full JSON Schema of a
 * booking would cost more than every other entry combined.
 */
export function describeShape(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const first = value.find((v) => v && typeof v === "object");
    return { kind: "array", of: first ? describeShape(first, depth + 1)?.fields ?? [] : typeof value[0] };
  }
  if (typeof value === "object") {
    // One level of unwrapping for the envelopes every API uses.
    if (depth === 0) {
      for (const key of ["data", "result", "items", "results"]) {
        if (value[key] !== undefined) return describeShape(value[key], depth + 1);
      }
    }
    return { kind: "object", fields: Object.keys(value).slice(0, 20) };
  }
  return { kind: typeof value };
}

/**
 * One request per declared-required field, each missing exactly that field.
 *
 * The declaration is a guess: Zod's `.optional()` and TypeScript's `?:` say
 * what the CLIENT believes, and the server is the one that decides. A request
 * missing a genuinely required field is rejected before anything is written,
 * which is what makes this safe to ask.
 */
export function omissionProbes(operation) {
  const fields = operation.bodyFields ?? [];
  const required = fields.filter((f) => f.required);
  if (!required.length) return [];

  const full = Object.fromEntries(fields.map((f) => [f.name, sampleFor(f)]));
  return required.map((field) => ({
    omitted: field.name,
    body: Object.fromEntries(Object.entries(full).filter(([k]) => k !== field.name)),
  }));
}

/** A value of the right type, so a rejection is about absence and not shape. */
function sampleFor(field) {
  if (field.enumValues?.length) return field.enumValues[0];
  switch (field.type) {
    case "number": return 1;
    case "boolean": return false;
    case "array": return [];
    default: return "probe";
  }
}

/**
 * What an omission proved.
 *
 * A rejection confirms the field is required. Anything else means it is not,
 * and the manifest is telling the model to always send something the app does
 * not need -- which is how an agent ends up inventing a value to fill a field
 * nobody asked for.
 */
export function readOmission(field, status) {
  if (status >= 400 && status < 500) return { field, required: true };
  if (status >= 500) return { field, required: null, note: "the server errored; nothing learned" };
  return { field, required: false, note: "accepted without it" };
}

/**
 * What the app calls a page, in its own words.
 *
 * The most useful description of a page is usually already rendered on it.
 * cal.diy's event-types page says "Event types / Configure different events
 * for people to book on your calendar" -- written by someone who knew what it
 * was for, and better than anything a model would invent from a filename.
 *
 * Reads the served HTML rather than a rendered DOM: heading, the line beneath
 * it, and the document title. That is enough for a server-rendered page and
 * costs nothing beyond the request the probe already makes.
 */
export function harvestPage(html) {
  if (!html || typeof html !== "string") return null;
  const title = clean(first(html, /<title[^>]*>([\s\S]*?)<\/title>/i));
  const heading = clean(first(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i));
  // The line after the heading is where apps put the one-sentence explanation.
  const subtitle = clean(first(html, /<h1[^>]*>[\s\S]*?<\/h1>\s*<(?:p|div|span)[^>]*>([\s\S]*?)<\/(?:p|div|span)>/i));
  return { title, heading, subtitle };
}

/**
 * Turns what every page said into a description for each.
 *
 * Cross-page on purpose. The product name is whichever title segment repeats
 * everywhere -- "Error | Cal.diy", "Availability | Cal.diy" -- and no single
 * page can tell which half that is. Picking the longer half chose "Cal.diy"
 * over "Error"; counting across pages cannot make that mistake.
 */
export function describePages(harvests) {
  const siteName = commonTitleSegment(harvests.map((h) => h.title));
  const out = [];
  for (const { path, title, heading, subtitle } of harvests) {
    const parts = [heading, subtitle].filter(Boolean).filter((p) => p.length > 1 && p.length < 160);
    const description = parts.length
      ? parts.map((p) => p.replace(/\.?$/, ".")).join(" ")
      : segmentsOf(title).filter((seg) => seg !== siteName).join(" ");
    const kept = worthSaying(description, path, siteName);
    if (kept) out.push({ path, description: kept });
  }
  return out;
}

const segmentsOf = (title) =>
  title ? title.split(/\s+[|\u2013\u2014-]\s+/).map((s) => s.trim()).filter(Boolean) : [];

/** The title segment that appears on most pages: the product name. */
function commonTitleSegment(titles) {
  const counts = new Map();
  for (const title of titles) {
    for (const segment of new Set(segmentsOf(title))) counts.set(segment, (counts.get(segment) ?? 0) + 1);
  }
  const present = titles.filter(Boolean).length;
  const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  // Only if it is on most of them; a two-page app has no repeating name.
  return best && best[1] > present / 2 ? best[0] : null;
}

/**
 * Rejects a description that only restates the path, or names the product.
 *
 * "/availability" described as "Availability" costs tokens and tells the model
 * nothing it could not read off the route itself.
 */
function worthSaying(description, path, siteName) {
  if (!description || description.length < 2) return null;
  const normalise = (value) => value.toLowerCase().replace(/[^a-z]/g, "");
  if (siteName && normalise(description) === normalise(siteName)) return null;
  const lastSegment = path.split("/").filter(Boolean).pop() ?? "";
  if (normalise(description) === normalise(lastSegment)) return null;
  return description;
}

const first = (text, re) => text.match(re)?.[1] ?? null;

/** Tags out, entities decoded, whitespace collapsed. */
function clean(value) {
  if (!value) return null;
  const text = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}
