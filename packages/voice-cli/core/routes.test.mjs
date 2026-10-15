import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isPattern, matchesPattern } from "./routes.js";

describe("route pattern classification", () => {
  test(":param and [param] segments are patterns", () => {
    assert.ok(isPattern("/availability/:schedule"));
    assert.ok(isPattern("/users/[id]"));
    assert.ok(isPattern("/blog/[...slug]"));
  });

  test("catch-all splats (* and $) are patterns, not concrete paths", () => {
    // Read as concrete, readiness probed the literal URL "/docs/*".
    assert.ok(isPattern("/docs/*"));
    assert.ok(isPattern("/files/$"));
  });

  test("a fully concrete path is not a pattern", () => {
    assert.equal(isPattern("/event-types"), false);
    assert.equal(isPattern("/bookings/upcoming"), false);
  });

  test("matchesPattern binds a splat segment", () => {
    assert.ok(matchesPattern("/docs/*", "/docs/intro"));
    assert.equal(matchesPattern("/docs/*", "/blog/intro"), false);
  });
});
