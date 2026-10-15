import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { trpc } from "../src/transports.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

describe("a validation error carries the fix, not just 'Invalid input'", () => {
  const errPayload = (fieldErrors) => ({
    error: { json: { message: "Invalid input", data: { zodError: { fieldErrors } } } },
  });

  test("the rejected field and its reason are surfaced", () => {
    assert.throws(() => trpc.read(errPayload({ scheduleId: ["Required"] }), { ok: false, status: 400 }),
      /Invalid input \(scheduleId: Required\)/);
  });

  test("several field errors are all named", () => {
    assert.throws(() => trpc.read(errPayload({ scheduleId: ["Required"], schedule: ["Expected array"] }), { ok: false }),
      /scheduleId: Required; schedule: Expected array/);
  });

  test("an error with no zodError still reads as before", () => {
    assert.throws(() => trpc.read({ error: { json: { message: "Unauthorized" } } }, { ok: false, status: 401 }),
      /^Error: Unauthorized$/);
  });
});

describe("a call that keeps failing the same way is stopped", () => {
  const provider = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/VoiceProvider.jsx"), "utf8");

  test("the widget tracks repeated identical failures and cuts them off", () => {
    assert.match(provider, /repeatFailRef/);
    assert.match(provider, /failed \$\{rf\.count\} times the same way/);
    // A different error resets the count -- correcting one field to reveal the
    // next is progress, not a loop.
    assert.match(provider, /key === rf\.key \? rf\.count \+ 1 : 1/);
  });
});

import { classifyError } from "../src/errors.js";

describe("errors are split by whether a retry could help", () => {
  test("a rate limit is transient; a validation error is not", () => {
    assert.equal(classifyError("Rate limit reached. Try again in 8s.").retryable, true);
    assert.equal(classifyError("Invalid input (schedule: Expected array)").retryable, false);
    assert.equal(classifyError("Unauthorized").retryable, false);
    assert.equal(classifyError("Not found").retryable, false);
  });

  test("an unknown error is treated as possibly-transient, never abandoned early", () => {
    assert.equal(classifyError("something odd happened").retryable, true);
  });

  test("a non-retryable failure is cut off early, and points at the DOM route", () => {
    const p = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/VoiceProvider.jsx"), "utf8");
    // The budget now comes from confidence (retryBudget), not a bare literal,
    // but a known action still keeps the 3-transient / 1-hard behaviour.
    assert.match(p, /const limit = retryBudget\(action, \{ retryable \}\)/);
    assert.match(p, /use the DOM tools/);
  });
});
