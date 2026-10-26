/**
 * The server half of the Orchestra provider: the one route your app serves.
 * It holds your app's secret key (from Orchestra) and trades it for a
 * short-lived session token for your page, so the key never reaches a
 * browser. The page (orchestra() in @expert/voice) asks it on its own, at
 * /voice/token by default, and renews the token when it lapses.
 *
 *   import { orchestraTokenHandler, toExpressHandler } from "@expert/voice-server/orchestra";
 *   app.post("/voice/token", toExpressHandler(orchestraTokenHandler()));   // ORCHESTRA_KEY, ORCHESTRA_URL
 *
 * Whoever can call this route can use voice on your app's account, within
 * its limits: gate it behind your app's login ({ requireAuth }), as you would
 * any route that acts for a signed-in user.
 */
import { json, readJson, toExpressHandler } from "./http.js";
import { buildGuard } from "./guards.js";

/**
 * @param {object} [opts]
 * @param {string} [opts.key]  your app's secret key; defaults to process.env.ORCHESTRA_KEY
 * @param {string} [opts.url]  the Orchestra service's origin; defaults to process.env.ORCHESTRA_URL
 * @param {(request)=>boolean|Promise<boolean>} [opts.requireAuth]  your login check; false -> 401
 * @param {string} [opts.secret]          a shared secret required on the route instead (Bearer or X-Voice-Secret)
 * @param {number|false} [opts.rateLimit] max requests per window per client (default 30; false to disable)
 * @param {boolean} [opts.trustAuth]      auth is enforced upstream; silences the unguarded warning
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {(request: Request) => Promise<Response>}
 */
export function orchestraTokenHandler(opts = {}) {
  const { key, url, fetchImpl = fetch } = opts;
  const guard = buildGuard({
    ...opts,
    label: "orchestraTokenHandler",
    risk: "/voice/token hands out sessions on your app's Orchestra account, so an unauthenticated public route lets anyone use it",
  });

  return async function handleToken(request) {
    const denied = await guard(request);
    if (denied) return denied;
    const base = String(url ?? process.env.ORCHESTRA_URL ?? "").replace(/\/+$/, "");
    const secret = key ?? process.env.ORCHESTRA_KEY;
    if (!base || !secret) return json(500, { error: "ORCHESTRA_URL and ORCHESTRA_KEY must be set on the server." });
    const { body } = await readJson(request);
    try {
      const r = await fetchImpl(`${base}/v1/sessions`, {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify(body?.session ? { session: body.session } : {}),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        return json(r.status === 401 ? 500 : 502, { error: r.status === 401 ? "Orchestra refused this app's key: check ORCHESTRA_KEY." : "Orchestra did not answer." });
      }
      // The service's origin goes back with the token: the page needs no setting of its own.
      return json(200, { token: data.token, session: data.session, expiresAt: data.expiresAt, url: base }, { "cache-control": "no-store" });
    } catch {
      return json(502, { error: "Orchestra is not reachable: check ORCHESTRA_URL." });
    }
  };
}

export { toExpressHandler };
