import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { expandTopic } from "../src/catalog.js";

const m = {
  queries: [{ name: "scheduleGet", description: "one schedule", group: ["availability", "schedule"] }],
  actions: [
    {
      name: "scheduleUpdate", description: "change hours", group: ["availability", "schedule"], requiresConfirmation: true, confidence: "review",
      bodyFields: [{ name: "schedule", type: "array", shape: "Array<Array<{ start, end }>>", dates: [["start"], ["end"]], review: { kind: "opaque", reason: "nested array" } }],
    },
    { name: "createTask", description: "new task" }, // root
  ],
  groups: [{ path: ["availability"], description: "when you are bookable" }],
};

describe("the widget answers expand from the manifest", () => {
  test("a string topic splits on / and descends", () => {
    const deep = expandTopic(m, "availability/schedule");
    assert.deepEqual(deep.tools.map((t) => t.name).sort(), ["scheduleGet", "scheduleUpdate"]);
    assert.equal(deep.tools.find((t) => t.name === "scheduleUpdate").requiresConfirmation, true);
  });

  test("a mid-tree topic returns its sub-topics, not its descendants' tools", () => {
    const top = expandTopic(m, "availability");
    assert.deepEqual(top.tools, []);
    assert.deepEqual(top.subtopics.map((s) => s.topic), ["availability/schedule"]);
    assert.equal(top.subtopics[0].description, "when you are bookable" === "" ? "" : top.subtopics[0].description);
  });

  test("an unknown topic is null so the dispatcher can report it", () => {
    assert.equal(expandTopic(m, "nope"), null);
  });

  test("a field's build-time tags (dates, review) never reach the model", () => {
    const tool = expandTopic(m, "availability/schedule").tools.find((t) => t.name === "scheduleUpdate");
    const field = tool.bodyFields.find((f) => f.name === "schedule");
    assert.equal(field.shape, "Array<Array<{ start, end }>>"); // the model keeps this
    assert.equal("dates" in field, false);
    assert.equal("review" in field, false);
    // ...but the confidence directive DOES travel, so the steer reaches a deep op.
    assert.equal(tool.confidence, "review");
  });

  test("root is reachable as the empty path", () => {
    const root = expandTopic(m, "");
    assert.deepEqual(root.tools.map((t) => t.name), ["createTask"]);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
const provider = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../src/VoiceProvider.jsx"), "utf8");

describe("the dispatcher teaches a model that calls a name directly", () => {
  test("run_query and run_action are the dispatch entry points", () => {
    assert.match(provider, /name === "run_query"/);
    assert.match(provider, /name === "run_action"/);
    assert.match(provider, /name === "expand"/);
  });

  test("a bare operation name is redirected to the right call, not just rejected", () => {
    // Observed live: a model called `availabilityScheduleGet(...)` and
    // `query(...)` instead of run_query, thrashed through five wrong shapes,
    // and gave up. The widget holds the manifest, so it can name the fix.
    assert.match(provider, /is an operation name, not a tool\. Call it as run_query/);
    assert.match(provider, /is an operation name, not a tool\. Call it as run_action/);
    assert.match(provider, /There is no "\$\{name\}" tool\. Use run_query/);
  });
});

describe("after a write, the app is made to reflect it", () => {
  test("refreshHost prefers onAfterAction, else nudges the host's data layer", () => {
    // A host that wired onAfterAction invalidates its own cache precisely; absent
    // it, a synthetic focus/visibilitychange makes React-Query/SWR refetch.
    assert.match(provider, /callbacksRef\.current\.onAfterAction/);
    assert.match(provider, /new Event\("focus"\)/);
    assert.match(provider, /new Event\("visibilitychange"\)/);
  });

  test("onAfterAction is handed the action context, once per operation not per item", () => {
    assert.match(provider, /refreshHost\(\{ name: action\.name/);
    // runAction is now a bare perform; the refresh moved to runBatch (one choke point).
    assert.match(provider, /const runAction = async \(action, args\) => perform\(action, args\)/);
  });
});
