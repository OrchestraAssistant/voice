// Relay security baseline (eval findings C1 / H1 / M4).
//
// The relay mints an OpenAI Realtime token billed to OPENAI_API_KEY, so an
// unguarded /voice/session is an open, billable proxy: anyone who can POST a
// manifest gets a working session credential on the owner's account. Everything
// here is ENV-GATED, so a localhost dev relay runs wide open (with a loud
// startup warning) while a hosted one locks down without touching code:
//
//   VOICE_ALLOWED_ORIGINS   comma-separated origins allowed cross-origin
//   VOICE_RELAY_SECRET      shared secret required on /voice/session and /voice/log
//   VOICE_RATE_LIMIT        max mints per window per client (default 30)
//   VOICE_RATE_WINDOW_MS    the window (default 60000)
//   VOICE_MAX_BODY          request-body cap (default "256kb")
//
// The secret is the real lock, and it assumes the pattern the README already
// recommends: the app's OWN backend proxies /voice and injects the secret
// server-side, so it never reaches the browser. A secret shipped to the page is
// not a secret.

import { timingSafeEqual } from "node:crypto";

/**
 * CORS options from an allowlist.
 *
 * Empty allowlist -> permissive (dev); the caller warns at startup. A set
 * allowlist reflects only listed origins. A request with NO Origin header
 * (curl, same-origin, a server-side proxy) is allowed through: those are not
 * browsers subject to the same-origin policy, so the origin check does nothing
 * for them anyway -- the secret guard is what stops non-browser abuse.
 */
export function corsOptionsFor(allowedOrigins = []) {
  if (!allowedOrigins.length) return {}; // wide open
  const set = new Set(allowedOrigins);
  return { origin: (origin, cb) => cb(null, !origin || set.has(origin)) };
}

/** Constant-time string compare, so the guard leaks neither length-equal-prefix
 * nor the secret by timing. Unequal lengths are already unequal. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * A shared-secret gate. No secret configured -> open (dev). Configured -> the
 * caller must present it as `Authorization: Bearer <secret>` or `X-Voice-Secret`.
 */
export function makeSecretGuard(secret) {
  return function secretGuard(req, res, next) {
    if (!secret) return next();
    const auth = req.get?.("authorization") || "";
    const bearer = /^Bearer\s+(.+)$/i.exec(auth)?.[1];
    const provided = bearer || req.get?.("x-voice-secret") || "";
    if (provided && safeEqual(provided, secret)) return next();
    return res.status(401).json({ error: "Unauthorized." });
  };
}

/**
 * A per-client sliding-window rate limiter, no dependency. Caps mint abuse even
 * when no secret is set -- a curl loop is stopped whether or not it is authed.
 * `now` is injectable for tests. Keyed on `req.ip`, so behind a proxy set
 * `trust proxy` (VOICE_TRUST_PROXY) for it to see the real client.
 */
export function makeRateLimiter({ max = 30, windowMs = 60_000, now = Date.now } = {}) {
  const hits = new Map(); // key -> timestamps[]

  function allow(key) {
    const t = now();
    const recent = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(t);
    hits.set(key, recent);
    return true;
  }

  function middleware(req, res, next) {
    const key = req.ip || req.socket?.remoteAddress || "unknown";
    if (!allow(key)) return res.status(429).json({ error: "Too many requests. Slow down." });
    next();
  }

  // Drop keys that have gone quiet, so the map cannot grow without bound.
  function sweep() {
    const t = now();
    for (const [key, ts] of hits) {
      const recent = ts.filter((x) => t - x < windowMs);
      if (recent.length) hits.set(key, recent);
      else hits.delete(key);
    }
  }

  return { middleware, allow, sweep, size: () => hits.size };
}

/**
 * A bounded, non-leaky message from an upstream error body or an exception (M4).
 *
 * The relay used to forward OpenAI's raw error object -- org ids, rate-limit
 * arithmetic, internal fields -- straight to an unauthenticated caller, and echo
 * raw exception strings on 500. Keep only the human `message`, trimmed; the full
 * detail is logged server-side by the caller.
 */
export function safeUpstreamMessage(data, fallback = "The voice provider rejected the session.") {
  const msg = data?.error?.message ?? (typeof data?.error === "string" ? data.error : "");
  if (typeof msg !== "string" || !msg) return fallback;
  return msg.length > 200 ? `${msg.slice(0, 197)}...` : msg;
}
