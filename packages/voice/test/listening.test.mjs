import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isListening } from "../src/listening.js";

/**
 * isListening() answers one question: can the user be heard right now. It is
 * what drives the rim, which is the widget's only promise about privacy, so it
 * is worth pinning down as a pure function rather than only observing it
 * through a rendered page.
 *
 * The case that matters most is a connection that is up with no microphone on
 * it. Nothing does that yet -- the mic is still acquired while connecting --
 * but warming a session ahead of the user asking to talk is exactly the change
 * this split exists to make safe, and the failure mode is the rainbow rim
 * announcing that we are listening to someone who never started.
 */
describe("isListening", () => {
  const live = { transport: "ready", micAttached: true, mode: "continuous", holding: false };

  test("a warm connection with no mic is not listening", () => {
    for (const mode of ["continuous", "ptt", "ptnt"]) {
      assert.equal(isListening({ transport: "ready", micAttached: false, mode, holding: false }), false);
      assert.equal(isListening({ transport: "ready", micAttached: false, mode, holding: true }), false);
    }
  });

  test("no transport is not listening, whatever the mic says", () => {
    for (const transport of ["idle", "connecting", "error"]) {
      assert.equal(isListening({ ...live, transport }), false);
    }
  });

  test("continuous is listening whenever the mic is attached", () => {
    assert.equal(isListening(live), true);
    assert.equal(isListening({ ...live, holding: true }), true);
  });

  test("push-to-talk listens only while held", () => {
    assert.equal(isListening({ ...live, mode: "ptt", holding: false }), false);
    assert.equal(isListening({ ...live, mode: "ptt", holding: true }), true);
  });

  test("push-to-not-talk listens except while held", () => {
    assert.equal(isListening({ ...live, mode: "ptnt", holding: false }), true);
    assert.equal(isListening({ ...live, mode: "ptnt", holding: true }), false);
  });
});
