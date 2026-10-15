import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cookieJar, pick, signedIn } from "./session.js";

describe("keeping a session", () => {
  test("cookies are collected as a server sets them", () => {
    const jar = cookieJar();
    jar.absorb(["next-auth.csrf-token=abc; Path=/; HttpOnly", "next-auth.session-token=xyz; Path=/; SameSite=Lax"]);
    assert.equal(jar.size(), 2);
    assert.match(jar.header(), /next-auth\.session-token=xyz/);
  });

  test("an expired cookie is a deletion, not a value", () => {
    // Sending a dead session back is worse than sending none: the app answers
    // as though someone is signed in and then fails halfway.
    const jar = cookieJar();
    jar.absorb(["session=live; Path=/"]);
    jar.absorb(["session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT"]);
    assert.equal(jar.size(), 0);
  });

  test("a later value replaces an earlier one", () => {
    const jar = cookieJar();
    jar.absorb(["session=first"]);
    jar.absorb(["session=second"]);
    assert.equal(jar.header(), "session=second");
  });

  test("a malformed header is ignored rather than stored", () => {
    const jar = cookieJar();
    jar.absorb(["", "novalue", "=novalue"]);
    assert.equal(jar.size(), 0);
  });
});

describe("reading the token out of a response", () => {
  test("by dotted path, because apps nest it differently", () => {
    assert.equal(pick({ csrfToken: "abc" }, "csrfToken"), "abc");
    assert.equal(pick({ data: { token: "abc" } }, "data.token"), "abc");
  });

  test("a missing path is null, not a crash", () => {
    assert.equal(pick({}, "a.b.c"), null);
    assert.equal(pick(null, "a"), null);
  });
});

describe("deciding whether sign-in worked", () => {
  test("a new cookie is the proof, not the status code", () => {
    // A login endpoint answering 200 with an error in the body is the normal
    // way to fail. A session IS a cookie: if none arrived, nothing happened.
    assert.equal(signedIn(1, 2), true);
    assert.equal(signedIn(2, 2), false);
    assert.equal(signedIn(3, 1), false);
  });
});
