/**
 * The relay's mint logic as a framework-agnostic handler, so an app can host it
 * in its OWN backend instead of running a separate relay. The handler is a
 * Web-standard `(Request) => Promise<Response>`:
 *
 *   // Next.js App Router -- app/api/voice/session/route.ts
 *   import { createVoiceSessionHandler } from "@expert/voice-openai/server";
 *   export const POST = createVoiceSessionHandler();   // reads OPENAI_API_KEY from env
 *
 *   // Express
 *   import { createVoiceSessionHandler, toExpressHandler } from ".../mintHandler.js";
 *   app.post("/api/voice/session", express.json(), toExpressHandler(createVoiceSessionHandler()));
 *
 * It does ONE thing: take the manifest the page sends, build the tool list and
 * instructions, mint an ephemeral OpenAI token, and return it. Auth, rate
 * limiting and CORS are deliberately left to the host -- mounted in your app, the
 * route already sits behind your own session, so only your users can spend your
 * budget. The standalone relay (index.js) adds those guards in front for the
 * multi-tenant case; security.js holds them.
 */
import { buildInstructions, buildTools, resolveModel, resolveLanguage, validateManifest } from "./tools.js";
import { safeUpstreamMessage } from "./security.js";

const jsonResponse = (status, obj) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

/**
 * @param {object} [opts]
 * @param {string} [opts.apiKey]        OpenAI key; defaults to process.env.OPENAI_API_KEY
 * @param {string} [opts.defaultModel]  default Realtime model
 * @param {typeof fetch} [opts.fetchImpl] injectable for tests
 * @param {(info:{model,language,manifest,data}) => void} [opts.onMinted] hook for logging
 * @returns {(request: Request) => Promise<Response>}
 */
export function createVoiceSessionHandler({ apiKey, defaultModel = "gpt-realtime", fetchImpl = fetch, onMinted } = {}) {
  return async function handleVoiceSession(request) {
    const key = apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) return jsonResponse(500, { error: "OPENAI_API_KEY is not set on the server." });

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(400, { error: "Expected a JSON body." });
    }

    const checked = validateManifest(body?.manifest);
    if (checked.error) return jsonResponse(400, { error: checked.error });
    if (checked.versionNote) console.warn(`voice-server: ${checked.versionNote}`);
    const wantedModel = resolveModel(body?.model, defaultModel);
    if (wantedModel.error) return jsonResponse(400, { error: wantedModel.error });
    const wantedLanguage = resolveLanguage(body?.language);
    if (wantedLanguage.error) return jsonResponse(400, { error: wantedLanguage.error });
    const surface = body?.surface === "extension" ? "extension" : null;

    try {
      const upstream = await fetchImpl("https://api.openai.com/v1/realtime/client_secrets", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          session: {
            type: "realtime",
            model: wantedModel.model,
            instructions: buildInstructions(checked.manifest, wantedLanguage.language, { surface }),
            tools: buildTools(checked.manifest, { surface }),
            tool_choice: "auto",
            audio: {
              output: { voice: "marin" },
              input: {
                turn_detection: { type: "server_vad", create_response: false },
                transcription: {
                  model: "gpt-live-transcribe",
                  ...(wantedLanguage.language ? { language: wantedLanguage.language.code } : {}),
                },
              },
            },
          },
        }),
      });

      const data = await upstream.json();
      if (!upstream.ok) {
        console.error("OpenAI client_secrets error:", data);
        return jsonResponse(upstream.status, { error: safeUpstreamMessage(data) });
      }
      onMinted?.({ model: wantedModel.model, language: wantedLanguage.language?.code ?? null, manifest: checked, data });
      return jsonResponse(200, data);
    } catch (err) {
      console.error(err);
      return jsonResponse(500, { error: "The server could not create a session." });
    }
  };
}

/**
 * Adapt a `(Request) => Promise<Response>` handler to an Express `(req, res)`.
 * Expects a JSON body parser (e.g. `express.json()`) upstream.
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
