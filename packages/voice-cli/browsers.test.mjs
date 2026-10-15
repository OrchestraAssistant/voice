import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { chromeDriver } from "./browsers/chrome.js";

/** Set an env var for the duration of fn, restoring it after. */
async function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (value == null) delete process.env[key];
  else process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (had) process.env[key] = prev;
    else delete process.env[key];
  }
}

describe("the chrome driver uses a browser that already exists", () => {
  test("an endpoint makes it available without any local binary", async () => {
    // The whole point: with a CDP endpoint set, the driver reports ready even
    // when there is nothing to launch -- it will connect, not own a process.
    await withEnv("VOICE_BROWSER_ENDPOINT", "http://localhost:9222", () =>
      withEnv("VOICE_BROWSER", null, async () => {
        const avail = await chromeDriver().available();
        // (skips if puppeteer-core is not installed; that is a separate concern)
        if (!avail.ok && /puppeteer-core is not installed/.test(avail.why)) return;
        assert.equal(avail.ok, true, "an endpoint is enough to be available");
        assert.equal(avail.using, "http://localhost:9222");
        assert.match(avail.how, /connected .* over CDP/);
      }),
    );
  });

  test("a ws:// endpoint is treated as a direct CDP endpoint", async () => {
    await withEnv("VOICE_BROWSER_ENDPOINT", "ws://localhost:9222/devtools/browser/abc", async () => {
      const avail = await chromeDriver().available();
      if (!avail.ok && /puppeteer-core is not installed/.test(avail.why)) return;
      assert.equal(avail.ok, true);
      assert.match(avail.how, /connected/);
    });
  });
});
