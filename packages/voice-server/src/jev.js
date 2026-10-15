/**
 * The JEV-cascade provider's SERVER HALF: a BYOK broker.
 *
 * It holds the JEV key (and your text model's key), so the browser never does.
 * Mount it at `/voice` and point the cascade's client half -- `jevBroker()` from
 * @expert/voice -- at the same base. It serves:
 *
 *   POST /evaluate   proxy a decision to JEV (api.typesafe.ai), translating our
 *                    neutral question/answer shape to and from JEV's wire shape.
 *   POST /generate   a free-text/reply completion from your text model.
 *
 *   // Next.js App Router -- app/voice/[...path]/route.ts
 *   import { jevBrokerHandler, openaiText } from "@expert/voice-server/jev";
 *   export const POST = jevBrokerHandler({ generate: openaiText() }); // keys from env
 *
 * Why a broker at all: a JEV/LLM key in the browser is a key anyone can lift.
 * The cascade hits this every turn, so for a production app put it at the edge.
 */
import { json, readJson, toExpressHandler } from "./http.js";

const JEV_URL = "https://api.typesafe.ai/v1/systemone";

/**
 * @param {object} [opts]
 * @param {string} [opts.jevKey]     JEV key; defaults to process.env.JEV_API_KEY
 * @param {string} [opts.jevUrl]     JEV endpoint (default api.typesafe.ai)
 * @param {string} [opts.jevModel]   JEV model (default "jev-latest")
 * @param {({prompt:string}) => Promise<string>} [opts.generate] your text model for /generate
 * @param {typeof fetch} [opts.fetchImpl] injectable for tests
 * @returns {(request: Request) => Promise<Response>}
 */
export function jevBrokerHandler({ jevKey, jevUrl = JEV_URL, jevModel = "jev-latest", generate, fetchImpl = fetch } = {}) {
  return async function handleJev(request) {
    const { pathname } = new URL(request.url);
    if (request.method !== "POST") {
      return json(404, { error: `The JEV broker takes POST /evaluate or /generate, not ${request.method} ${pathname}.` });
    }
    const { body, error } = await readJson(request);
    if (error) return error;

    if (pathname.endsWith("/evaluate")) {
      const key = jevKey ?? process.env.JEV_API_KEY;
      if (!key) return json(500, { error: "JEV_API_KEY is not set on the server." });

      // Neutral question shape -> JEV wire. A boolean is JEV's `noul` (0..1).
      const questions = {};
      for (const [name, q] of Object.entries(body?.questions ?? {})) {
        questions[name] =
          q.type === "boolean"
            ? { type: "noul", instructions: q.instructions, criteria: { true: "yes", false: "no" } }
            : { type: q.type, instructions: q.instructions, criteria: q.criteria ?? {} };
      }

      let upstream;
      try {
        upstream = await fetchImpl(jevUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ state: body?.state, model: jevModel, questions }),
        });
      } catch {
        return json(502, { error: "Could not reach JEV." });
      }
      const data = await upstream.json().catch(() => ({}));
      if (!upstream.ok) return json(upstream.status, { error: "JEV rejected the request." });

      // JEV wire -> neutral. `noul` is a probability; a choice carries its own.
      const answers = {};
      for (const [name, a] of Object.entries(data?.answers ?? {})) {
        answers[name] =
          a.type === "noul"
            ? { type: "boolean", probability: a.noul }
            : { type: "choice", choice: a.choice, probabilities: a.probabilities, confidence: a.confidence };
      }
      return json(200, { answers });
    }

    if (pathname.endsWith("/generate")) {
      if (typeof generate !== "function") {
        return json(500, { error: "This JEV broker has no generate(): wire a text model, e.g. generate: openaiText({ apiKey })." });
      }
      try {
        const text = await generate({ prompt: body?.prompt ?? "" });
        return json(200, { text: text ?? "" });
      } catch {
        return json(502, { error: "The text model failed." });
      }
    }

    return json(404, { error: `No JEV route for ${pathname}. Expected /evaluate or /generate.` });
  };
}

/**
 * A ready-made `generate` backed by OpenAI chat completions, so the broker is
 * drop-in without wiring your own text model. Supply your own `generate` for any
 * other LLM -- it is just `({ prompt }) => Promise<string>`.
 */
export function openaiText({ apiKey, model = "gpt-4o-mini", fetchImpl = fetch } = {}) {
  return async function generate({ prompt }) {
    const key = apiKey ?? process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is not set for openaiText().");
    const r = await fetchImpl("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0 }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error("OpenAI text model error.");
    return data?.choices?.[0]?.message?.content ?? "";
  };
}

export { toExpressHandler };
