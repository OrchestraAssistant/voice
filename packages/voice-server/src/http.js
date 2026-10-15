// Shared server helpers for the provider handlers. Framework-agnostic: every
// handler is a Web `(Request) => Promise<Response>`, with a thin Express adapter
// for backends that aren't on the Web-standard request/response.

export const json = (status, obj, extraHeaders) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });

/** Read a JSON body, returning { body } or { error: <400 Response> }. */
export async function readJson(request) {
  try {
    return { body: await request.json() };
  } catch {
    return { error: json(400, { error: "Expected a JSON body." }) };
  }
}

/**
 * Adapt a Web `(Request) => Promise<Response>` handler to an Express `(req, res)`.
 * Expects a JSON body parser (e.g. `express.json()`) mounted upstream.
 */
export function toExpressHandler(handle) {
  return async (req, res) => {
    const request = new Request(`http://localhost${req.originalUrl || req.url}`, {
      method: req.method,
      headers: req.headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(req.body ?? {}),
    });
    const response = await handle(request);
    res.status(response.status);
    response.headers.forEach((v, k) => res.setHeader(k, v));
    res.send(await response.text());
  };
}
