/**
 * How a manifest operation becomes an HTTP request.
 *
 * Two shapes so far. `rest` is a URL with parameters substituted, a query
 * string, and a JSON body. `trpc` is not REST at all: procedures are addressed
 * by path, input is superjson-wrapped as `{ json: ... }`, and it travels in a
 * query string for a query and in the body for a mutation. Sending a tRPC
 * procedure a plain REST body gets a 400 that says nothing useful.
 *
 * Pure on purpose. Building the request and reading the response are the parts
 * that are easy to get subtly wrong and impossible to check by eye, so they
 * are separated from the fetch that performs them.
 */

/** Substitutes {name} placeholders, leaving the rest of the path alone. */
export function buildUrl(template, args) {
  let url = template;
  for (const [key, value] of Object.entries(args)) {
    url = url.replace(`{${key}}`, encodeURIComponent(value));
  }
  return url;
}

export const rest = {
  request({ operation, args }) {
    const url = buildUrl(operation.endpoint, args);
    const query = (operation.params ?? [])
      .filter((p) => p.source === "query-string" && args[p.name] != null)
      .map((p) => `${encodeURIComponent(p.name)}=${encodeURIComponent(args[p.name])}`)
      .join("&");

    if (operation.method === "GET") return { method: "GET", url: query ? `${url}?${query}` : url };

    // Only declared body fields are sent. Anything else the model invented
    // would be passed straight through to the app's API.
    const allowed = new Set((operation.bodyFields ?? []).map((f) => f.name));
    const body = Object.fromEntries(Object.entries(args).filter(([k, v]) => allowed.has(k) && v !== undefined));
    return { method: operation.method, url, body: Object.keys(body).length ? body : undefined };
  },

  read(payload, { ok, status } = { ok: true }) {
    if (!ok) throw new Error(payload?.error || `Request failed: ${status}`);
    return payload;
  },
};

/**
 * superjson's wire format, but only the part we emit: a payload plus a `meta`
 * map naming the values that are not plain JSON.
 *
 * tRPC runs superjson as its transformer, so the server does
 * `superjson.deserialize({ json, meta })` BEFORE zod ever sees the input. A
 * `z.date()` field is the case that bites: superjson encodes a Date as its ISO
 * string in `json` and records `["Date"]` at its path in `meta.values`; the
 * server reads the meta and revives the string into a Date. Send the ISO string
 * with no meta -- which is what `{ json: args }` did -- and it stays a string,
 * and `z.date()` answers "Expected date, received string" no matter how correct
 * the string is. Measured: cal.diy's schedule update rejected a perfectly valid
 * `1970-01-01T09:00:00.000Z` on exactly this.
 *
 * Only Dates are annotated. That is the one superjson type the manifest can flag
 * (see the date coercion below) and the only one an operation has been seen to
 * need; everything else already round-trips as plain JSON. With no Dates present
 * the result is `{ json }` with no `meta`, byte-identical to the old envelope,
 * so nothing that did not carry a date changes.
 */
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

/**
 * Turn declared date fields from the string the model sent into real Dates, so
 * superjsonSerialize above can tag them.
 *
 * The manifest carries, per field, the key-paths that end at a `z.date()` --
 * `[["start"], ["end"]]` for cal.diy's `schedule: Array<Array<{start, end}>>`.
 * Arrays are TRANSPARENT: a path steps through object keys and recurses into
 * every array element without consuming a segment, because the schedule's dates
 * live under two levels of positional array. An empty path (`[]`) means the
 * field value is itself a date.
 *
 * A string the model sent that is not a real date -- `"09:00"` with no day --
 * becomes an Invalid Date, which cannot be serialised, so it is left as the
 * original string. The server then answers "Invalid date" rather than the
 * widget throwing, which is the more useful of the two failures.
 */
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

/**
 * A tRPC error, with the validation detail the model needs to fix its call.
 *
 * "Invalid input" alone is useless: the model that sent the wrong field names
 * gets no hint and guesses again. tRPC's zodError carries exactly the fix --
 * `{"scheduleId":["Required"]}` names the field it wanted -- and flattening it
 * to the top-level message threw that away. Measured: an update failed 18 times
 * with 14 different guessed shapes because "Invalid input" said nothing.
 *
 * Surfaced as "Invalid input (scheduleId: Required)", short enough to cost
 * almost nothing and specific enough to be self-correcting.
 */
function withValidationDetail(detail) {
  const base = detail?.message ?? "tRPC call failed";
  const fieldErrors = detail?.data?.zodError?.fieldErrors;
  if (!fieldErrors) return base;
  const parts = Object.entries(fieldErrors)
    .map(([field, msgs]) => `${field}: ${(Array.isArray(msgs) ? msgs : [msgs]).join(", ")}`)
    .filter(Boolean);
  return parts.length ? `${base} (${parts.join("; ")})` : base;
}

export const trpc = {
  request({ operation, args }) {
    // URL parameters are not a thing here: every value is input to the
    // procedure. Anything the endpoint template does interpolate has already
    // been substituted, so pass the rest through whole.
    /**
     * The envelope goes on ALWAYS, even with nothing in it.
     *
     * A query with no arguments used to omit `?input=` entirely, so tRPC
     * parsed the input as `undefined` -- and a zod object rejects `undefined`
     * even when every field inside it is optional:
     *
     *     z.object({ scheduleId: z.optional(z.number()) })
     *        .safeParse(undefined)  ->  REJECTED: Required
     *        .safeParse({})         ->  accepted
     *
     * So a procedure that takes nothing mandatory answered "Invalid input" to
     * a call that asked for nothing. Two of cal.diy's availability queries are
     * exactly that shape, and a session spent five tool calls and most of a
     * rate limit discovering it before giving up on the task.
     *
     * The mutation branch below already knew this -- an empty body is not "no
     * arguments" either -- and the lesson simply never crossed the two lines
     * between them. A procedure with no input parser at all ignores what it is
     * sent, so there is nothing to lose by always sending it.
     */
    // Declared date fields arrive as strings and must become Dates before
    // superjson can tag them; then the envelope carries the meta the server
    // needs to revive them. Both are no-ops for an operation with no dates.
    const dated = coerceDeclaredDates(args ?? {}, [...(operation.params ?? []), ...(operation.bodyFields ?? [])]);
    const input = superjsonSerialize(dated);

    if (operation.method === "GET") {
      const url = buildUrl(operation.endpoint, args);
      return { method: "GET", url: `${url}?input=${encodeURIComponent(JSON.stringify(input))}` };
    }
    return { method: "POST", url: buildUrl(operation.endpoint, args), body: input };
  },

  /**
   * Unwraps `{ result: { data: { json: X } } }`, and turns
   * `{ error: { json: { message } } }` into a real error.
   *
   * tRPC answers errors with a structured body, so a caller that only checks
   * the HTTP status reports "Request failed: 401" and throws away the reason.
   */
  read(payload, { ok, status } = { ok: true }) {
    if (payload?.error) {
      const detail = payload.error.json ?? payload.error;
      throw new Error(withValidationDetail(detail));
    }
    if (!ok) throw new Error(`Request failed: ${status}`);
    const data = payload?.result?.data;
    return data && "json" in data ? data.json : data;
  },
};

/**
 * GraphQL: one endpoint, POST always, the operation carried as a document.
 *
 * Unlike REST and tRPC there is no URL to build -- every operation goes to the
 * same `/graphql` endpoint, and WHICH operation is decided by the query
 * document itself. So the manifest carries `document` (the exact gql source the
 * producer read) and `operationName`, and the model's arguments become the
 * GraphQL `variables`. `document`/`operationName` never reach the model -- the
 * catalog projection whitelists what a tool exposes, and they are not on it --
 * so a large query string costs nothing in the prompt.
 */
export const graphql = {
  request({ operation, args }) {
    // Only declared variables are sent; anything the model invented is dropped,
    // exactly as REST does for body fields.
    const allowed = new Set((operation.bodyFields ?? []).map((f) => f.name));
    const variables = Object.fromEntries(
      Object.entries(args ?? {}).filter(([k, v]) => allowed.has(k) && v !== undefined),
    );
    return {
      method: "POST",
      url: operation.endpoint || "/graphql",
      body: {
        query: operation.document,
        ...(operation.operationName ? { operationName: operation.operationName } : {}),
        ...(Object.keys(variables).length ? { variables } : {}),
      },
    };
  },

  /**
   * GraphQL answers 200 OK with an `errors` array on failure, so a caller that
   * only checks the HTTP status calls a failed mutation a success. The messages
   * are the fix the model needs, the same reason the tRPC reader keeps them.
   */
  read(payload, { ok, status } = { ok: true }) {
    if (payload?.errors?.length) {
      const message = payload.errors.map((e) => e?.message).filter(Boolean).join("; ");
      throw new Error(message || "GraphQL request failed");
    }
    if (!ok) throw new Error(`Request failed: ${status}`);
    return payload?.data ?? payload;
  },
};

export const TRANSPORTS = { rest, trpc, graphql };

/** Which transport an operation uses. Absent means REST, which every manifest
 *  written before tRPC existed relies on. */
export const transportFor = (operation) => TRANSPORTS[operation?.transport] ?? rest;
