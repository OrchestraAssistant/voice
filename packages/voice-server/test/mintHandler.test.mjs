import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createVoiceSessionHandler, toExpressHandler } from "../src/core/mintHandler.js";

const req = (bodyObj) =>
  new Request("http://localhost/api/voice/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bodyObj),
  });

/** A fake OpenAI endpoint that records the request and returns a canned token. */
function fakeOpenAI({ ok = true, status = 200, data = { value: "ek_test", expires_at: 123 } } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok, status, json: async () => data };
  };
  return { fetchImpl, calls };
}

describe("createVoiceSessionHandler", () => {
  test("mints a token and sends tools + instructions built from the manifest", async () => {
    const oa = fakeOpenAI();
    const handle = createVoiceSessionHandler({ apiKey: "sk-test", fetchImpl: oa.fetchImpl });
    const res = await handle(req({ manifest: { queries: [{ name: "tasks" }], actions: [] }, model: "gpt-realtime" }));

    assert.equal(res.status, 200);
    assert.equal((await res.json()).value, "ek_test");
    const sent = oa.calls[0].body.session;
    assert.equal(oa.calls[0].url, "https://api.openai.com/v1/realtime/client_secrets");
    assert.ok(Array.isArray(sent.tools) && sent.tools.some((t) => t.name === "run_query"), "tools were not built");
    assert.equal(typeof sent.instructions, "string");
    assert.equal(sent.model, "gpt-realtime");
  });

  test("passes surface:extension through to the tool build", async () => {
    const oa = fakeOpenAI();
    const handle = createVoiceSessionHandler({ apiKey: "sk-test", fetchImpl: oa.fetchImpl });
    await handle(req({ manifest: { queries: [], actions: [] }, surface: "extension" }));
    assert.ok(oa.calls[0].body.session.tools.some((t) => t.name === "open_url"), "extension tools missing");
  });

  test("a bad manifest is a 400, never reaching OpenAI", async () => {
    const oa = fakeOpenAI();
    const handle = createVoiceSessionHandler({ apiKey: "sk-test", fetchImpl: oa.fetchImpl });
    const res = await handle(req({ manifest: "nope" }));
    assert.equal(res.status, 400);
    assert.equal(oa.calls.length, 0);
  });

  test("a missing key is a 500", async () => {
    const res = await createVoiceSessionHandler({ apiKey: "" })(req({ manifest: { queries: [], actions: [] } }));
    assert.equal(res.status, 500);
  });

  test("an upstream error forwards the status with a bounded message", async () => {
    const oa = fakeOpenAI({ ok: false, status: 429, data: { error: { message: "Rate limited.", param: "x", type: "y" } } });
    const handle = createVoiceSessionHandler({ apiKey: "sk-test", fetchImpl: oa.fetchImpl });
    const res = await handle(req({ manifest: { queries: [], actions: [] } }));
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error, "Rate limited.");
  });
});

describe("toExpressHandler", () => {
  test("adapts the handler to (req, res)", async () => {
    const oa = fakeOpenAI();
    const handler = toExpressHandler(createVoiceSessionHandler({ apiKey: "sk-test", fetchImpl: oa.fetchImpl }));
    const captured = {};
    const res = {
      status(c) { captured.status = c; return this; },
      setHeader() {},
      send(b) { captured.body = b; },
    };
    await handler(
      { method: "POST", url: "/api/voice/session", headers: {}, body: { manifest: { queries: [], actions: [] } } },
      res,
    );
    assert.equal(captured.status, 200);
    assert.equal(JSON.parse(captured.body).value, "ek_test");
  });
});
