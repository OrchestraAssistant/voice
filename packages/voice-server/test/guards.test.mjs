import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openaiVoiceHandler } from "../src/openai.js";
import { safeEqual, presentedSecret, createRateLimiter, clientIdFromRequest } from "../src/guards.js";

const req = (method, path, body, headers) =>
  new Request(`http://x${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

const MANIFEST = { routes: [], queries: [], actions: [] };
// A fetch that always mints, so "reached the mint" is observable as status 200.
const okFetch = async () => new Response(JSON.stringify({ value: "ek_test", expires_at: 1 }), { status: 200 });

describe("guards -- units", () => {
  test("safeEqual matches equal strings, rejects unequal and non-strings", () => {
    assert.equal(safeEqual("abc", "abc"), true);
    assert.equal(safeEqual("abc", "abd"), false);
    assert.equal(safeEqual("abc", "ab"), false);
    assert.equal(safeEqual("abc", undefined), false);
  });

  test("presentedSecret reads Bearer and X-Voice-Secret", () => {
    assert.equal(presentedSecret(req("POST", "/", null, { authorization: "Bearer s3cr3t" })), "s3cr3t");
    assert.equal(presentedSecret(req("POST", "/", null, { "x-voice-secret": "s3cr3t" })), "s3cr3t");
    assert.equal(presentedSecret(req("POST", "/", null, {})), null);
  });

  test("clientIdFromRequest prefers the first x-forwarded-for hop", () => {
    assert.equal(clientIdFromRequest(req("POST", "/", null, { "x-forwarded-for": "1.1.1.1, 2.2.2.2" })), "1.1.1.1");
    assert.equal(clientIdFromRequest(req("POST", "/", null, { "x-real-ip": "3.3.3.3" })), "3.3.3.3");
  });

  test("rate limiter allows up to max then blocks within the window", () => {
    const check = createRateLimiter({ max: 2, windowMs: 10000 });
    assert.equal(check("a").ok, true);
    assert.equal(check("a").ok, true);
    assert.equal(check("a").ok, false);
    assert.equal(check("b").ok, true); // a different client is independent
  });
});

describe("openaiVoiceHandler -- guard wiring", () => {
  // Every handler below is deliberately configured, so none should warn; mute
  // defensively so a stray warning never pollutes the suite.
  let warn;
  before(() => {
    warn = console.warn;
    console.warn = () => {};
  });
  after(() => {
    console.warn = warn;
  });

  test("a shared secret: /session rejects without it, passes with it", async () => {
    const h = openaiVoiceHandler({ apiKey: "k", fetchImpl: okFetch, secret: "s3cr3t" });
    assert.equal((await h(req("POST", "/voice/session", { manifest: MANIFEST }))).status, 401);
    const ok = await h(req("POST", "/voice/session", { manifest: MANIFEST }, { authorization: "Bearer s3cr3t" }));
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).value, "ek_test");
  });

  test("requireAuth false -> 401 before the mint is reached", async () => {
    let minted = false;
    const h = openaiVoiceHandler({
      apiKey: "k",
      fetchImpl: async () => ((minted = true), new Response("{}", { status: 200 })),
      requireAuth: () => false,
    });
    assert.equal((await h(req("POST", "/voice/session", { manifest: MANIFEST }))).status, 401);
    assert.equal(minted, false, "mint must not run when auth denies");
  });

  test("requireAuth true lets the request through", async () => {
    const h = openaiVoiceHandler({ apiKey: "k", fetchImpl: okFetch, requireAuth: async () => true });
    assert.equal((await h(req("POST", "/voice/session", { manifest: MANIFEST }))).status, 200);
  });

  test("rate limit returns 429 with Retry-After once exceeded", async () => {
    const h = openaiVoiceHandler({ apiKey: "k", fetchImpl: okFetch, trustAuth: true, rateLimit: 1 });
    const headers = { "x-forwarded-for": "9.9.9.9" };
    assert.equal((await h(req("POST", "/voice/session", { manifest: MANIFEST }, headers))).status, 200);
    const blocked = await h(req("POST", "/voice/session", { manifest: MANIFEST }, headers));
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get("retry-after"), "sets Retry-After");
  });

  test("/options is never gated (the picker loads pre-auth)", async () => {
    const h = openaiVoiceHandler({ apiKey: "k", secret: "s3cr3t" });
    assert.equal((await h(req("GET", "/voice/options"))).status, 200);
  });
});

describe("openaiVoiceHandler -- the unguarded warning", () => {
  test("warns once when created with no auth guard", () => {
    const warn = console.warn;
    const msgs = [];
    console.warn = (m) => msgs.push(String(m));
    try {
      openaiVoiceHandler({ apiKey: "k" }); // no secret/requireAuth/trustAuth
    } finally {
      console.warn = warn;
    }
    assert.equal(msgs.length, 1);
    assert.match(msgs[0], /no auth guard/i);
    assert.match(msgs[0], /billable/i);
  });

  test("does NOT warn when a guard or trustAuth is set", () => {
    const warn = console.warn;
    const msgs = [];
    console.warn = (m) => msgs.push(String(m));
    try {
      openaiVoiceHandler({ apiKey: "k", secret: "s" });
      openaiVoiceHandler({ apiKey: "k", requireAuth: () => true });
      openaiVoiceHandler({ apiKey: "k", trustAuth: true });
    } finally {
      console.warn = warn;
    }
    assert.equal(msgs.length, 0);
  });
});
