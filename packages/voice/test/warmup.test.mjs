import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isUsable } from "../src/realtimeClient.js";

const src = (f) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src", f), "utf8");

describe("warming", () => {
  test("a key is usable until it is nearly out of time", () => {
    // Measured: expires_at comes back ~600s out, not the 60s the docs'
    // summaries suggest. The margin covers a slow connect after the check.
    assert.equal(isUsable({ key: "k", expiresAt: Date.now() + 600_000 }), true);
    assert.equal(isUsable({ key: "k", expiresAt: Date.now() + 30_000 }), false);
    assert.equal(isUsable({ key: "k", expiresAt: Date.now() - 1 }), false);
    assert.equal(isUsable(null), false);
    assert.equal(isUsable({ expiresAt: Date.now() + 600_000 }), false, "no key is not usable");
  });

  test("freshness is checked at the point of use, not left to a timer", () => {
    // A backgrounded tab has its intervals throttled to roughly one a minute,
    // so a refresh timer may simply not fire. The check before use is the
    // guarantee; the timer is an optimisation.
    const p = src("VoiceProvider.jsx");
    assert.match(p, /const ensureMinted = useCallback\([\s\S]{0,400}if \(isUsable\(mintedRef\.current, wanted\)\) return/);
    assert.match(p, /minted: await ensureMinted\(/);
  });

  test("a key minted for one model is not reused for another", () => {
    // Model and language are session-CREATION parameters; neither can be
    // changed on a live session. Reusing a key minted before the user changed
    // the setting opens a session on the old model and ignores the choice.
    const key = { key: "k", expiresAt: Date.now() + 600_000, for: { model: "gpt-realtime", language: null } };
    assert.equal(isUsable(key, { model: "gpt-realtime", language: null }), true);
    assert.equal(isUsable(key, { model: "gpt-realtime-mini", language: null }), false);
    assert.equal(isUsable(key, { model: "gpt-realtime", language: "es" }), false);
    assert.equal(isUsable(key), true, "with nothing wanted, only expiry matters");
  });

  test("concurrent callers share one mint", () => {
    // The freshness check reads a ref and the mint is a round trip, so two
    // callers arriving inside that window both saw "no key" and both minted.
    // The warm effect depends on `model`, which is null until the relay's
    // options arrive and then becomes the default -- so it fires twice within
    // a few hundred ms of mount, and StrictMode's double-mount adds more.
    // Real sessions showed three and four mints inside 300ms.
    const p = src("VoiceProvider.jsx");
    assert.match(p, /if \(mintingRef\.current\) return mintingRef\.current/);
    assert.match(p, /mintingRef\.current = null/, "an in-flight mint has to be cleared or the next one never runs");
  });

  test("warming never attaches a microphone", () => {
    // A warm connection with micAttached false keeps isListening() false, so
    // the rim stays dark on a session the user never started. Scoped to the
    // warm() body: `start()` legitimately sets it, and lives nearby.
    const p = src("VoiceProvider.jsx");
    const body = p.slice(p.indexOf("const warm = useCallback"), p.indexOf("// \"eager\" mints on mount"));
    assert.ok(body.length > 200, "could not isolate warm()");
    assert.match(body, /withMic: false/);
    assert.doesNotMatch(body, /setMicAttached\(true\)/);
    assert.doesNotMatch(body, /attachMic/);
  });

  test("the audio sender is negotiated up front so no renegotiation is needed", () => {
    // replaceTrack does not renegotiate; addTrack after the fact would need a
    // second offer/answer, which this endpoint may not accept. This lives in
    // webrtcTransport.js now: the protocol was separated from the wire so the
    // protocol could be driven by a test instead of grepped for.
    const c = src("webrtcTransport.js");
    assert.match(c, /addTransceiver\("audio", \{ direction: "sendrecv" \}\)/);
    assert.match(c, /sender\.replaceTrack\(micTrack\)/);
  });

  test("warming is silent about its own failures", () => {
    // Nobody asked for it. The Talk button mints again and reports properly.
    assert.match(src("VoiceProvider.jsx"), /catch \{\s*\n\s*setTransport\("idle"\); \/\/ silent/);
  });
});

describe("the default strategy", () => {
  test("is hover, and hover mints on mount", () => {
    const p = src("VoiceProvider.jsx");
    assert.match(p, /warmup = "hover"/);
    // "hover" and "eager" both keep a key in hand; only the connect trigger
    // differs between them.
    assert.match(p, /warmup !== "eager" && warmup !== "hover"/);
  });

  test("off really does nothing", () => {
    assert.match(src("VoiceProvider.jsx"), /if \(warmup === "off" \|\| sessionRef\.current/);
  });

  test("touch devices fall back to the panel-open trigger", () => {
    // There is no pointerenter on a touchscreen, so hover alone would warm
    // nothing there.
    const b = src("InterpreterBubble.jsx");
    assert.match(b, /if \(selected !== null\) warm\?\.\(\)/);
    assert.match(b, /warmup === "hover" \? \(\) => warm\?\.\(\) : undefined/);
  });
});
