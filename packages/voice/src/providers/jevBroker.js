/**
 * Client half of the JEV cascade's broker.
 *
 * Turns a route your app serves -- `jevBrokerHandler` from @expert/voice-server/jev,
 * mounted at `/voice` -- into the `{ evaluate, generateText }` the cascade
 * providers need. Keys stay on the server; this only POSTs to your route, so it
 * is safe in the browser.
 *
 *   import { moonshineJev, moonshineStt, jevBroker } from "@expert/voice";
 *   const provider = moonshineJev({ stt: moonshineStt(), ...jevBroker("") }); // same-origin /voice
 *
 * The one argument is the base origin the route is mounted under -- "" for
 * same-origin (the common case), or an absolute origin if the broker is
 * elsewhere. It mirrors `relayUrl` for the realtime provider.
 */
export function jevBroker(baseUrl = "", { fetchImpl } = {}) {
  const doFetch = fetchImpl ?? ((...a) => fetch(...a));
  const post = async (suffix, payload) => {
    const r = await doFetch(`${baseUrl}/voice/${suffix}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!r.ok) throw new Error(`voice broker /${suffix} HTTP ${r.status}`);
    return r.json();
  };
  return {
    evaluate: async (state, questions) => (await post("evaluate", { state, questions })).answers ?? {},
    generateText: async ({ prompt }) => (await post("generate", { prompt })).text ?? "",
  };
}
