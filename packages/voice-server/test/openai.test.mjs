import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openaiVoiceHandler } from "../src/openai.js";

const req = (method, path, body) =>
  new Request(`http://x${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

const MANIFEST = { routes: [], queries: [], actions: [] };

describe("openaiVoiceHandler -- the realtime provider's server half", () => {
  // These exercise routing/mint, not auth, so they construct unguarded handlers
  // on purpose; mute the (expected) unguarded warning. guards.test.mjs asserts it.
  let warn;
  before(() => {
    warn = console.warn;
    console.warn = () => {};
  });
  after(() => {
    console.warn = warn;
  });

  test("GET /voice/options serves the model and language lists", async () => {
    const res = await openaiVoiceHandler({ apiKey: "k" })(req("GET", "/voice/options"));
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.models) && data.models.length, "models");
    assert.ok(Array.isArray(data.languages) && data.languages.length, "languages");
    assert.equal(data.defaults.model, "gpt-realtime");
  });

  test("POST /voice/session mints against OpenAI (injected fetch), keyed from opts", async () => {
    let called = null;
    const fakeFetch = async (url, init) => {
      called = { url, init };
      return new Response(JSON.stringify({ value: "ephemeral", expires_at: 123 }), { status: 200 });
    };
    const res = await openaiVoiceHandler({ apiKey: "sk-test", fetchImpl: fakeFetch })(
      req("POST", "/voice/session", { manifest: MANIFEST }),
    );
    assert.equal(res.status, 200);
    assert.match(called.url, /realtime\/client_secrets/);
    assert.match(called.init.headers.Authorization, /Bearer sk-test/);
    assert.equal((await res.json()).value, "ephemeral");
  });

  test("a custom model/language list is served", async () => {
    const res = await openaiVoiceHandler({
      apiKey: "k",
      models: [{ id: "gpt-realtime", label: "Only" }],
      languages: [{ code: "auto", label: "Auto" }],
      defaultModel: "gpt-realtime",
    })(req("GET", "/voice/options"));
    const data = await res.json();
    assert.equal(data.models.length, 1);
    assert.equal(data.models[0].label, "Only");
  });

  test("no OPENAI key -> 500", async () => {
    delete process.env.OPENAI_API_KEY;
    const res = await openaiVoiceHandler({ apiKey: "" })(req("POST", "/voice/session", { manifest: MANIFEST }));
    assert.equal(res.status, 500);
  });

  test("POST /voice/log is accepted and handed to onLog", async () => {
    let logged = null;
    const res = await openaiVoiceHandler({ apiKey: "k", onLog: (e) => (logged = e) })(
      req("POST", "/voice/log", { event: "x" }),
    );
    assert.equal(res.status, 204);
    assert.deepEqual(logged, { event: "x" });
  });

  test("an unknown route -> 404", async () => {
    const res = await openaiVoiceHandler({ apiKey: "k" })(req("POST", "/voice/nope", {}));
    assert.equal(res.status, 404);
  });
});
