import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { jevBroker } from "../src/providers/jevBroker.js";

// The client half only POSTs to a route; drive it with an injected fetch and
// assert it hits the right paths and unwraps the broker's envelope.
function captureFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(responder(url)), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

describe("jevBroker -- the cascade's client half", () => {
  test("evaluate() posts {state,questions} to <base>/voice/evaluate and returns answers", async () => {
    const { fetchImpl, calls } = captureFetch(() => ({ answers: { a: { type: "boolean", probability: 0.7 } } }));
    const b = jevBroker("", { fetchImpl });
    const answers = await b.evaluate("state here", { a: { type: "boolean", instructions: "?" } });
    assert.equal(calls[0].url, "/voice/evaluate");
    assert.equal(calls[0].body.state, "state here");
    assert.deepEqual(answers, { a: { type: "boolean", probability: 0.7 } });
  });

  test("generateText() posts {prompt} to <base>/voice/generate and returns text", async () => {
    const { fetchImpl, calls } = captureFetch(() => ({ text: "filled" }));
    const b = jevBroker("https://api.example.com", { fetchImpl });
    const text = await b.generateText({ prompt: "write the id" });
    assert.equal(calls[0].url, "https://api.example.com/voice/generate");
    assert.equal(calls[0].body.prompt, "write the id");
    assert.equal(text, "filled");
  });

  test("a non-2xx throws with the route named", async () => {
    const b = jevBroker("", { fetchImpl: async () => new Response("nope", { status: 502 }) });
    await assert.rejects(() => b.evaluate("s", {}), /\/evaluate HTTP 502/);
  });
});
