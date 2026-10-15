import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { confidenceOf, retryBudget, screenSteer } from "../src/policy.js";

describe("confidenceOf", () => {
  test("absent means known", () => {
    assert.equal(confidenceOf({ name: "x" }), "known");
    assert.equal(confidenceOf({ confidence: "review" }), "review");
  });
});

describe("retryBudget", () => {
  test("known keeps today's behaviour: 3 for transient, 1 for a hard error", () => {
    assert.equal(retryBudget({}, { retryable: true }), 3);
    assert.equal(retryBudget({}, { retryable: false }), 1);
  });
  test("unknown gets one try -- a guessed body a retry only re-sends", () => {
    assert.equal(retryBudget({ confidence: "unknown" }, { retryable: true }), 1);
    assert.equal(retryBudget({ confidence: "unknown" }, { retryable: false }), 1);
  });
  test("review gets a little slack only when the error is transient", () => {
    assert.equal(retryBudget({ confidence: "review" }, { retryable: true }), 2);
    assert.equal(retryBudget({ confidence: "review" }, { retryable: false }), 1);
  });
});

describe("screenSteer", () => {
  test("a known action gets no steer -- the API is its path", () => {
    assert.equal(screenSteer({ name: "x" }), null);
  });

  test("a low-confidence action is steered to the screen, softly and with a way out", () => {
    const steer = screenSteer({ confidence: "review", name: "scheduleUpdate", page: "availability" });
    assert.match(steer, /try doing it on the screen/i);
    assert.match(steer, /dom_snapshot/);
    assert.match(steer, /availability screen/);
    // The way out, so it does not loop on an impossible task.
    assert.match(steer, /stop and tell the user/i);
    // Soft, not an order.
    assert.doesNotMatch(steer, /\byou must\b/i);
  });

  test("unknown and review give different reasons", () => {
    assert.match(screenSteer({ confidence: "unknown" }), /inputs could not be read/);
    assert.match(screenSteer({ confidence: "review" }), /details that could not be read/);
  });
});
