import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { orchestraTokenHandler } from "../src/orchestra.js";

const post = (body = {}, headers = {}) =>
  new Request("http://app.test/voice/token", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

/** Orchestra's /v1/sessions, faked: one known key. */
function service() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
    if (init.headers.authorization !== "Bearer osk_right") return new Response("{}", { status: 401 });
    return new Response(JSON.stringify({ token: "tok", session: "ses_1", expiresAt: "2026-10-26T12:00:00Z" }));
  };
  return { calls, fetchImpl };
}

describe("the Orchestra token route", () => {
  test("trades the app's key for a session token, and names the service for the page", async () => {
    const s = service();
    const handle = orchestraTokenHandler({ key: "osk_right", url: "https://orchestra.test/", fetchImpl: s.fetchImpl, trustAuth: true });
    const r = await handle(post({ session: "ses_1" }));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { token: "tok", session: "ses_1", expiresAt: "2026-10-26T12:00:00Z", url: "https://orchestra.test" });
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(s.calls[0].url, "https://orchestra.test/v1/sessions");
    assert.deepEqual(s.calls[0].body, { session: "ses_1" });
  });

  test("the key never reaches the page, even when refused", async () => {
    const s = service();
    const r = await orchestraTokenHandler({ key: "osk_wrong", url: "https://orchestra.test", fetchImpl: s.fetchImpl, trustAuth: true })(post());
    assert.equal(r.status, 500);
    const text = await r.text();
    assert.match(text, /ORCHESTRA_KEY/);
    assert.doesNotMatch(text, /osk_wrong/);
  });

  test("unconfigured, it says what to set", async () => {
    const before = { ...process.env };
    delete process.env.ORCHESTRA_KEY;
    delete process.env.ORCHESTRA_URL;
    try {
      const r = await orchestraTokenHandler({ trustAuth: true })(post());
      assert.equal(r.status, 500);
      assert.match((await r.json()).error, /ORCHESTRA_URL and ORCHESTRA_KEY/);
    } finally {
      Object.assign(process.env, before);
    }
  });

  test("the app's own login gates it", async () => {
    const s = service();
    const handle = orchestraTokenHandler({ key: "osk_right", url: "https://orchestra.test", fetchImpl: s.fetchImpl, requireAuth: (req) => req.headers.get("cookie") === "signed-in" });
    assert.equal((await handle(post())).status, 401);
    assert.equal((await handle(post({}, { cookie: "signed-in" }))).status, 200);
    assert.equal(s.calls.length, 1);
  });
});
