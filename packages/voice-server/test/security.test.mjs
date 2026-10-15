import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { corsOptionsFor, makeSecretGuard, makeRateLimiter, safeUpstreamMessage } from "../src/core/security.js";

/** A fake express res that records status + json, and a next() flag. */
function fakeCtx(headers = {}) {
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.body = obj;
      return this;
    },
  };
  const req = { get: (h) => headers[h.toLowerCase()], ip: headers.ip };
  let nexted = false;
  const next = () => {
    nexted = true;
  };
  return { req, res, next, wasNexted: () => nexted };
}

describe("corsOptionsFor", () => {
  test("no allowlist is wide open (dev)", () => {
    assert.deepEqual(corsOptionsFor([]), {});
  });

  test("an allowlist reflects only listed origins, and lets origin-less callers through", () => {
    const { origin } = corsOptionsFor(["https://app.example.com"]);
    const check = (o) => new Promise((r) => origin(o, (_e, ok) => r(ok)));
    return Promise.all([
      check("https://app.example.com").then((ok) => assert.equal(ok, true, "listed origin allowed")),
      check("https://evil.example.com").then((ok) => assert.equal(ok, false, "unlisted origin blocked")),
      check(undefined).then((ok) => assert.equal(ok, true, "no-Origin (curl/proxy) allowed -- the secret guards those")),
    ]);
  });
});

describe("makeSecretGuard", () => {
  test("no secret configured -> open (dev)", () => {
    const { req, res, next, wasNexted } = fakeCtx();
    makeSecretGuard(null)(req, res, next);
    assert.ok(wasNexted());
    assert.equal(res.statusCode, null);
  });

  test("secret set -> 401 without it", () => {
    const { req, res, next, wasNexted } = fakeCtx();
    makeSecretGuard("s3cret")(req, res, next);
    assert.equal(wasNexted(), false);
    assert.equal(res.statusCode, 401);
  });

  test("secret set -> 401 on a wrong value", () => {
    const { req, res, next } = fakeCtx({ authorization: "Bearer nope" });
    makeSecretGuard("s3cret")(req, res, next);
    assert.equal(res.statusCode, 401);
  });

  test("accepts the secret as a Bearer token", () => {
    const { req, res, next, wasNexted } = fakeCtx({ authorization: "Bearer s3cret" });
    makeSecretGuard("s3cret")(req, res, next);
    assert.ok(wasNexted());
  });

  test("accepts the secret as X-Voice-Secret", () => {
    const { req, res, next, wasNexted } = fakeCtx({ "x-voice-secret": "s3cret" });
    makeSecretGuard("s3cret")(req, res, next);
    assert.ok(wasNexted());
  });
});

describe("makeRateLimiter", () => {
  test("allows up to max, then blocks, within the window", () => {
    let t = 1000;
    const rl = makeRateLimiter({ max: 3, windowMs: 1000, now: () => t });
    assert.ok(rl.allow("1.1.1.1"));
    assert.ok(rl.allow("1.1.1.1"));
    assert.ok(rl.allow("1.1.1.1"));
    assert.equal(rl.allow("1.1.1.1"), false, "the 4th in-window request is blocked");
  });

  test("a different client has its own budget", () => {
    let t = 1000;
    const rl = makeRateLimiter({ max: 1, windowMs: 1000, now: () => t });
    assert.ok(rl.allow("a"));
    assert.equal(rl.allow("a"), false);
    assert.ok(rl.allow("b"), "b is not limited by a's usage");
  });

  test("the window slides: old hits expire", () => {
    let t = 1000;
    const rl = makeRateLimiter({ max: 1, windowMs: 1000, now: () => t });
    assert.ok(rl.allow("a"));
    assert.equal(rl.allow("a"), false);
    t += 1001; // past the window
    assert.ok(rl.allow("a"), "the window slid, so a can mint again");
  });

  test("the middleware answers 429 when blocked", () => {
    const rl = makeRateLimiter({ max: 0, windowMs: 1000 });
    const { req, res, next, wasNexted } = fakeCtx({ ip: "9.9.9.9" });
    rl.middleware(req, res, next);
    assert.equal(res.statusCode, 429);
    assert.equal(wasNexted(), false);
  });

  test("sweep drops quiet keys so the map cannot grow unbounded", () => {
    let t = 1000;
    const rl = makeRateLimiter({ max: 5, windowMs: 1000, now: () => t });
    rl.allow("a");
    assert.equal(rl.size(), 1);
    t += 2000;
    rl.sweep();
    assert.equal(rl.size(), 0);
  });
});

describe("safeUpstreamMessage", () => {
  test("returns the human message, not the whole body", () => {
    assert.equal(safeUpstreamMessage({ error: { message: "Rate limited.", code: "x", param: "y" } }), "Rate limited.");
  });

  test("trims a long message", () => {
    const msg = safeUpstreamMessage({ error: { message: "z".repeat(500) } });
    assert.ok(msg.length <= 200);
    assert.ok(msg.endsWith("..."));
  });

  test("falls back when there is no message", () => {
    assert.match(safeUpstreamMessage({}), /rejected the session/);
    assert.match(safeUpstreamMessage(null), /rejected the session/);
  });
});
