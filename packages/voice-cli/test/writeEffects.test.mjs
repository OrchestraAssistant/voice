import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { encodeOperation, unwrapReply, at, classifyEffect } from "../core/effects.js";
import { writeEffects } from "../stages/probe/writeEffects.js";

describe("encodeOperation", () => {
  const update = { name: "u", transport: "trpc", method: "POST", endpoint: "/api/trpc/schedule.update" };

  test("a declared date field is superjson-tagged, like the widget sends it", () => {
    const op = { ...update, bodyFields: [{ name: "scheduleId" }, { name: "schedule", dates: [["start"], ["end"]] }] };
    const { body } = encodeOperation(op, {
      scheduleId: 50,
      schedule: [[{ start: "1970-01-01T09:00:00.000Z", end: "1970-01-01T17:00:00.000Z" }], []],
    });
    assert.deepEqual(body.json.schedule[0][0], { start: "1970-01-01T09:00:00.000Z", end: "1970-01-01T17:00:00.000Z" });
    assert.deepEqual(body.meta, {
      values: { "schedule.0.0.start": ["Date"], "schedule.0.0.end": ["Date"] },
    });
  });

  test("no dates means a plain envelope, byte-identical to the old one", () => {
    const { body } = encodeOperation({ ...update, bodyFields: [{ name: "name" }] }, { name: "x" });
    assert.deepEqual(body, { json: { name: "x" } });
  });

  test("a tRPC query carries superjson input in the query string", () => {
    const q = { name: "list", transport: "trpc", method: "GET", endpoint: "/api/trpc/list" };
    const { method, url } = encodeOperation(q, {});
    assert.equal(method, "GET");
    assert.match(url, /\?input=/);
    assert.deepEqual(JSON.parse(decodeURIComponent(url.split("input=")[1])), { json: {} });
  });
});

describe("classifyEffect", () => {
  test("a 4xx is a rejection, not a no-op", () => {
    assert.equal(classifyEffect({ status: 400, before: 1, after: 1 }).outcome, "rejected");
  });
  test("a 2xx that moved the value is verified", () => {
    assert.equal(classifyEffect({ status: 200, before: [1, 2], after: [0, 6] }).outcome, "verified");
  });
  test("a 2xx that moved nothing is the silent no-op", () => {
    assert.equal(classifyEffect({ status: 200, before: [1, 2], after: [1, 2] }).outcome, "silent-noop");
  });
});

test("at() walks a dot/index path", () => {
  assert.deepEqual(at({ schedules: [{ availability: [{ days: [1, 2] }] }] }, "schedules.0.availability.0.days"), [1, 2]);
});

/**
 * The stage against a fake app. `goodUpdate` writes what it is sent;
 * `trapUpdate` mimics cal.diy's schedule.update -- it answers 200 either way but
 * only writes when `name` is present. The probe must call the first verified and
 * the second, when name is omitted, a silent no-op.
 */
describe("write-effects stage", () => {
  const manifest = {
    queries: [{ name: "list", transport: "trpc", method: "GET", endpoint: "/api/trpc/list" }],
    actions: [
      { name: "goodUpdate", transport: "trpc", method: "POST", endpoint: "/api/trpc/good.update", bodyFields: [{ name: "days" }] },
      { name: "trapUpdate", transport: "trpc", method: "POST", endpoint: "/api/trpc/trap.update", bodyFields: [{ name: "name" }, { name: "days" }] },
    ],
  };

  // One shared store; each fake reads and writes it, so a real change shows on
  // the next read exactly as a real app would.
  function fakeApp() {
    const store = { days: [1, 2, 3, 4, 5] };
    return async (method, url, body) => {
      if (url.startsWith("/api/trpc/list")) {
        return { status: 200, body: { result: { data: { json: { days: store.days } } } } };
      }
      const input = body?.json ?? {};
      if (url.startsWith("/api/trpc/good.update")) {
        if (input.days) store.days = input.days;
        return { status: 200, body: { result: { data: { json: { ok: true } } } } };
      }
      if (url.startsWith("/api/trpc/trap.update")) {
        if (input.name && input.days) store.days = input.days; // the trap: name gates the write
        return { status: 200, body: { result: { data: { json: { ok: true } } } } };
      }
      return { status: 404, body: null };
    };
  }

  test("a write that moves state is verified", async () => {
    const effects = {
      goodUpdate: { read: { query: "list" }, observe: "days", write: { days: [0, 6] } },
    };
    const out = await writeEffects.run({ manifest, ask: fakeApp(), effects });
    assert.deepEqual(out.corrections.actions, [{ name: "goodUpdate", verified: true }]);
    assert.equal(out.problems?.length ?? 0, 0);
  });

  test("a 2xx that changes nothing is surfaced as a problem", async () => {
    const effects = {
      trapUpdate: { read: { query: "list" }, observe: "days", write: { days: [0, 6] } }, // no name -> silent no-op
    };
    const out = await writeEffects.run({ manifest, ask: fakeApp(), effects });
    assert.deepEqual(out.corrections.actions, [{ name: "trapUpdate", verified: false }]);
    assert.equal(out.problems.length, 1);
    assert.match(out.problems[0], /did not change/);
  });

  test("the same trap passes once the load-bearing field is supplied", async () => {
    const effects = {
      trapUpdate: { read: { query: "list" }, observe: "days", write: { name: "Weekend", days: [0, 6] } },
    };
    const out = await writeEffects.run({ manifest, ask: fakeApp(), effects });
    assert.deepEqual(out.corrections.actions, [{ name: "trapUpdate", verified: true }]);
  });

  test("reads go through askFresh, so a cached ask cannot hide the change", async () => {
    // A GET cache that returns the first read forever would make every write a
    // false no-op. The stage must read via the uncached askFresh; here `ask`
    // (the write path) also serves a FROZEN read to prove it is not used for reads.
    const live = fakeApp();
    const frozenRead = { status: 200, body: { result: { data: { json: { days: [1, 2, 3, 4, 5] } } } } };
    const ask = async (method, url, body) => (url.startsWith("/api/trpc/list") ? frozenRead : live(method, url, body));
    const effects = { goodUpdate: { read: { query: "list" }, observe: "days", write: { days: [0, 6] } } };
    const out = await writeEffects.run({ manifest, ask, askFresh: live, effects });
    assert.deepEqual(out.corrections.actions, [{ name: "goodUpdate", verified: true }]);
  });

  test("no fixture is a clean skip, not an error", async () => {
    const out = await writeEffects.run({ manifest, ask: fakeApp(), effects: null });
    assert.match(out.notes[0], /no --effects fixture/);
  });

  test("restore puts the instance back after a verified write", async () => {
    const ask = fakeApp();
    const effects = {
      goodUpdate: {
        read: { query: "list" },
        observe: "days",
        write: { days: [0, 6] },
        restore: { days: [1, 2, 3, 4, 5] },
      },
    };
    await writeEffects.run({ manifest, ask, effects });
    const back = await ask("GET", "/api/trpc/list");
    assert.deepEqual(back.body.result.data.json.days, [1, 2, 3, 4, 5]);
  });
});
