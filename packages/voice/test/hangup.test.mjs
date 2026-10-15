import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const provider = readFileSync(resolve(here, "../src/VoiceProvider.jsx"), "utf8");

/**
 * "Off" is two decisions at two speeds, and getting either speed wrong is a
 * real failure: releasing the microphone late means a live mic after the user
 * said they were done, and closing the connection early throws away a
 * session-scoped prompt cache over a ten-second pause.
 */
describe("what a hang-up turns off", () => {
  const standDown = provider.slice(provider.indexOf("const standDown"), provider.indexOf("hangUpRef.current = standDown"));

  test("the microphone goes immediately, not on the timer", () => {
    assert.match(standDown, /await sessionRef\.current\?\.releaseMic\(\)/);
    assert.match(standDown, /setMicAttached\(false\)/);
    const release = standDown.indexOf("releaseMic");
    const timer = standDown.indexOf("setTimeout");
    assert.ok(release < timer, "the microphone must be released before anything is scheduled");
  });

  test("the connection is closed later, and only if nobody came back", () => {
    assert.match(standDown, /if \(sessionRef\.current && !sessionRef\.current\.hasMic\(\)\) stop\(\)/);
  });

  test("the connection is never closed on the spot", () => {
    // The only stop() in here is inside the timer. A bare one would make every
    // goodbye cost a full reconnect on the next word, which is exactly the
    // trade this two-speed design exists to avoid.
    const [before, inside] = standDown.split("setTimeout");
    assert.ok(!before.includes("stop()"), "stop() runs before the timer is even set");
    assert.equal((inside.match(/stop\(\)/g) ?? []).length, 1);
  });

  test("a staged destructive action does not survive being dismissed", () => {
    // Otherwise "that's all" leaves a delete waiting, and some later "yes"
    // executes something nobody is thinking about any more.
    assert.match(standDown, /setPendingAction\(null\)/);
  });

  test("coming back cancels the close", () => {
    const start = provider.slice(provider.indexOf("const start = async"), provider.indexOf("const stop = "));
    assert.match(start, /clearTimeout\(idleCloseRef\.current\)/);
  });

  test("unmounting cancels it too", () => {
    // It would otherwise fire stop() against a session already torn down.
    assert.match(provider, /useEffect\(\(\) => \(\) => clearTimeout\(idleCloseRef\.current\), \[\]\)/);
  });
});

describe("which sessions can hang up", () => {
  test("both of them, including the one warming built", () => {
    // warm() connects before the user has asked to talk, and start() ADOPTS
    // that session rather than making a new one. A handler wired only into
    // start() would therefore be missing from every warmed session, which is
    // the default path.
    const wired = provider.match(/onHangUp: \(info\) => hangUpRef\.current\?\.\(info\)/g) ?? [];
    assert.equal(wired.length, 2, "every connectRealtimeSession call needs the handler");
  });

  test("the host is told, with the words that did it", () => {
    assert.match(provider, /callbacksRef\.current\.onHangUp\?\.\(\{ because \}\)/);
  });
});
