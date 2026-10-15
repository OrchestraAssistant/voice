/**
 * Signing in, so the probe measures the app people actually use.
 *
 * Without a session most routes answer with a redirect to a login page, which
 * the probe correctly records as "exists" and nothing more. Every question
 * worth asking -- is this page real, what does it say about itself, what does
 * this query return, which fields does the server require -- is answered by
 * the logged-in version. Signing in roughly triples what a probe can learn
 * rather than merely polishing it.
 *
 * The sequence is described in a file rather than in arguments, because
 * credentials in a command end up in shell history.
 *
 *   {
 *     "csrf": { "url": "/api/auth/csrf", "pick": "csrfToken", "as": "csrfToken" },
 *     "post": { "url": "/api/auth/callback/credentials",
 *               "form": { "email": "pro@example.com", "password": "pro" } }
 *   }
 *
 * `csrf` is optional and covers the common case of a token that has to be
 * fetched before it can be posted back. `form` posts url-encoded, which is
 * what login endpoints overwhelmingly expect; `json` posts JSON instead.
 */

/** Cookies as a server set them, rendered as a request header. */
export function cookieJar() {
  const jar = new Map();
  return {
    absorb(setCookieHeaders = []) {
      for (const header of setCookieHeaders) {
        const [pair] = header.split(";");
        const index = pair.indexOf("=");
        if (index < 1) continue;
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        // An expired cookie is a deletion, and keeping it sends a dead session.
        if (/expires=thu, 01 jan 1970/i.test(header) || value === "") jar.delete(name);
        else jar.set(name, value);
      }
    },
    header: () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; "),
    /**
     * The same session, in the shape a browser wants.
     *
     * A probe that signs in over HTTP and then opens a browser has two
     * sessions, and the browser's is anonymous -- so every protected route
     * bounces to the login page and the stage measures that instead. Handing
     * the jar over is what makes the two halves one visit.
     */
    /**
     * The session in the shape CDP wants, keeping the cookie names intact.
     *
     * A `__Secure-`/`__Host-` prefixed cookie may only be SET in a secure
     * context, and CDP enforces it: give it a `domain` with an `http` page and
     * it rejects the whole batch, and RENAMING the cookie to drop the prefix
     * makes the app hunt for a name that is no longer there. The way through is
     * a `url` field on an `https://` origin -- CDP then treats the set as
     * secure and accepts the prefixed name, and the browser sends it on every
     * request regardless of the scheme it is actually navigating.
     *
     * So the URL handed in should be the app's real, secure origin (the one
     * login happened against), even when the pages are then fetched over
     * http://localhost behind a proxy.
     */
    forBrowser: (url) => {
      const origin = new URL(url).origin;
      return [...jar.entries()].map(([name, value]) => ({ name, value, url: origin }));
    },
    size: () => jar.size,
  };
}

/** Reads a value out of a JSON body by dotted path. */
export function pick(body, path) {
  if (!path) return null;
  return path.split(".").reduce((value, key) => (value == null ? value : value[key]), body) ?? null;
}

/**
 * Whether signing in worked.
 *
 * A login endpoint answering 200 with an error in the body is the normal way
 * to fail, so the status alone proves nothing. What proves it is a cookie that
 * was not there before -- a session is a cookie, and if none arrived, nothing
 * happened.
 */
export function signedIn(before, after) {
  return after > before;
}
