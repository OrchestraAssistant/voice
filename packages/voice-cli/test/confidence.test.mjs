import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { confidence, confidenceOf } from "../stages/confidence.js";

describe("confidenceOf", () => {
  test("no flags is known", () => {
    assert.equal(confidenceOf({ name: "x" }), "known");
  });
  test("an opaque or truncated field is review", () => {
    assert.equal(confidenceOf({ review: [{ kind: "opaque" }] }), "review");
    assert.equal(confidenceOf({ review: [{ kind: "truncated" }] }), "review");
  });
  test("an unknown field wins over an opaque one", () => {
    assert.equal(confidenceOf({ review: [{ kind: "opaque" }, { kind: "unknown" }] }), "unknown");
  });
  test("the probe verdict outranks the static flags", () => {
    // A fixture that actually changed state proves the API path despite the flag.
    assert.equal(confidenceOf({ review: [{ kind: "opaque" }], verified: true }), "known");
    // A silent no-op condemns it even with a clean shape.
    assert.equal(confidenceOf({ verified: false }), "review");
  });
});

describe("the confidence stage", () => {
  test("stamps review/unknown and leaves known off to save bytes", () => {
    const actions = [
      { name: "clean" },
      { name: "opaqueOne", review: [{ kind: "opaque" }] },
      { name: "emptyOne", review: [{ kind: "unknown" }] },
    ];
    const out = confidence.run({ manifest: { actions } });
    assert.equal("confidence" in actions[0], false, "known is the default, left off");
    assert.equal(actions[1].confidence, "review");
    assert.equal(actions[2].confidence, "unknown");
    assert.match(out.notes[0], /1 to review, 1 unknown/);
  });

  test("a previously-stamped op that is now known has the mark removed", () => {
    const op = { name: "wasFlagged", confidence: "review", verified: true };
    confidence.run({ manifest: { actions: [op] } });
    assert.equal("confidence" in op, false);
  });
});
