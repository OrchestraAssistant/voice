/**
 * Opt-in guards for the mountable handlers.
 *
 * The standalone relay holds the full multi-tenant guards in
 * src/core/security.js -- CORS, a shared-secret lock, a per-client rate limiter
 * -- because it answers the open internet. The mountable handler is meant to
 * sit behind the host app's own session, so by default it carries none of that
 * and trusts the route's upstream auth.
 *
 * But a `/voice/session` mounted on a public path with no auth in front is an
 * open, billable OpenAI proxy: anyone who can reach it mints tokens on your key.
 * So the handler ships two things here -- an opt-in secret / auth hook / rate
 * limit, and a one-time warning when it is created with none of them -- so the
 * common misconfiguration is loud instead of silent.
 *
 * Everything here is edge-safe: no node:crypto, no Buffer, no Node globals, so
 * the bundle still runs unchanged on Workers/Deno/Bun.
 */

/**
 * Constant-time-ish string compare. Not a cryptographic guarantee across every
 * JS engine, but it removes the trivial early-exit that `===` leaks on the first
 * differing byte -- enough for a shared-secret check that is already the second
 * line behind the host's own auth.
 */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** The secret a request presents: `Authorization: Bearer <s>` or `X-Voice-Secret`. */
export function presentedSecret(request, header = "x-voice-secret") {
  const auth = request.headers.get("authorization");
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "");
  return request.headers.get(header) ?? null;
}

/** Best-effort client identity for rate limiting, from the usual proxy headers. */
export function clientIdFromRequest(request) {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return request.headers.get("x-real-ip") || "unknown";
}

/**
 * A sliding-window, in-memory rate limiter. Per-instance only (so on a
 * multi-instance edge deploy each instance keeps its own window) -- a backstop
 * against a single client hammering one instance, not a global quota. Mirrors
 * the relay's limiter, which is also in-memory.
 */
export function createRateLimiter({ max = 30, windowMs = 60000 } = {}) {
  const hits = new Map(); // id -> timestamps[]
  return function check(id) {
    const now = Date.now();
    const recent = (hits.get(id) || []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(id, recent);
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
    }
    return { ok: recent.length <= max, retryAfter: Math.ceil(windowMs / 1000) };
  };
}

/**
 * Build the guard a handler runs on its billable routes. Returns `null` when no
 * guard is configured (and warns once that the route is unprotected), otherwise
 * an `async (request) => Response | null` that returns a 401/429 Response to
 * reject, or null to let the request through.
 *
 * @param {object} opts
 * @param {string}   [opts.secret]      require this shared secret on the request
 * @param {string}   [opts.secretHeader="x-voice-secret"]
 * @param {(request)=>boolean|Promise<boolean>} [opts.requireAuth] custom check; false -> 401
 * @param {number|false} [opts.rateLimit=30]  max requests per window, or false to disable
 * @param {number}   [opts.rateWindowMs=60000]
 * @param {(request)=>string} [opts.clientId]  identity for the limiter
 * @param {boolean}  [opts.trustAuth]   the host enforces auth upstream; silences the warning
 * @param {string}   [opts.label="openaiVoiceHandler"]  name used in the warning
 */
export function buildGuard(opts = {}) {
  const {
    secret,
    secretHeader = "x-voice-secret",
    requireAuth,
    rateLimit = 30,
    rateWindowMs = 60000,
    clientId = clientIdFromRequest,
    trustAuth = false,
    label = "openaiVoiceHandler",
  } = opts;

  const limiter = rateLimit === false ? null : createRateLimiter({ max: rateLimit, windowMs: rateWindowMs });

  if (!secret && !requireAuth && !trustAuth) {
    console.warn(
      `⚠  ${label}: mounted with no auth guard. /voice/session mints OpenAI ` +
        `tokens billed to your key, so an unauthenticated public route is an open, ` +
        `billable proxy. Gate the route behind your app's auth, or pass { requireAuth }, ` +
        `{ secret }, or { trustAuth: true } if auth is enforced upstream. ` +
        `(A per-IP rate limit${limiter ? " is" : " is NOT"} active${limiter ? "" : " -- rateLimit:false"}.)`,
    );
  }

  const json = (status, obj, extra) =>
    new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...extra } });

  return async function guard(request) {
    if (limiter) {
      const { ok, retryAfter } = limiter(clientId(request));
      if (!ok) return json(429, { error: "Too many requests." }, { "retry-after": String(retryAfter) });
    }
    if (secret) {
      const presented = presentedSecret(request, secretHeader);
      if (!presented || !safeEqual(presented, secret)) return json(401, { error: "Unauthorized." });
    }
    if (requireAuth) {
      let ok = false;
      try {
        ok = await requireAuth(request);
      } catch {
        ok = false;
      }
      if (!ok) return json(401, { error: "Unauthorized." });
    }
    return null;
  };
}
