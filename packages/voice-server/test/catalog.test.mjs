import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { nodeAt, rootCatalog, expand, opLine } from "../src/core/catalog.js";

const m = {
  queries: [
    { name: "tasksList", description: "list tasks" },                          // root
    { name: "scheduleGet", description: "one schedule", group: ["availability", "schedule"] },
    { name: "appsList", description: "installed apps", group: ["apps"] },
  ],
  actions: [
    {
      name: "scheduleUpdate", description: "change hours", group: ["availability", "schedule"], requiresConfirmation: true, confidence: "review",
      bodyFields: [
        { name: "scheduleId", required: true, type: "number" },
        { name: "schedule", required: false, type: "array", shape: "Array<Array<{ start, end }>>", dates: [["start"], ["end"]], review: { kind: "opaque", reason: "nested array" } },
      ],
    },
    { name: "createTask", description: "new task", bodyFields: [{ name: "title", required: true }] }, // root
  ],
  groups: [
    { path: ["availability"], description: "when you are bookable" },
    { path: ["apps"], description: "integrations" },
  ],
};

describe("the tool tree", () => {
  test("root holds only ungrouped operations", () => {
    const { direct, topics } = nodeAt(m, []);
    assert.deepEqual(direct.map((o) => o.name).sort(), ["createTask", "tasksList"]);
    assert.deepEqual(topics.map((t) => t.name).sort(), ["apps", "availability"]);
  });

  test("a topic counts everything beneath it, at any depth", () => {
    const availability = nodeAt(m, []).topics.find((t) => t.name === "availability");
    assert.equal(availability.count, 2, "scheduleGet + scheduleUpdate");
    assert.equal(availability.description, "when you are bookable");
  });

  test("the root catalog shows root ops in full and topics as names", () => {
    const cat = rootCatalog(m);
    assert.match(cat, /run_query/);
    assert.match(cat, /tasksList/);
    assert.match(cat, /createTask -- takes: title/);
    assert.match(cat, /availability -- when you are bookable \(2 tools\)/);
    assert.doesNotMatch(cat, /scheduleUpdate/, "a grouped op is not spelled out at root");
  });

  test("expand descends one level and reveals sub-topics", () => {
    const top = expand(m, "availability");
    assert.deepEqual(top.tools, [], "nothing sits directly at availability");
    assert.deepEqual(top.subtopics.map((s) => s.topic), ["availability/schedule"]);

    const deep = expand(m, "availability/schedule");
    assert.deepEqual(deep.tools.map((t) => t.name).sort(), ["scheduleGet", "scheduleUpdate"]);
    assert.equal(deep.tools.find((t) => t.name === "scheduleUpdate").requiresConfirmation, true);
  });

  test("an unknown topic returns null, not an empty node", () => {
    assert.equal(expand(m, "nope"), null);
  });

  test("expand keeps a field's shape for the model but strips off-prompt tags", () => {
    // `dates` is transport encoding and `review` is a build-time triage flag;
    // neither belongs in the prompt. The model still gets name/required/shape.
    const field = expand(m, "availability/schedule").tools
      .find((t) => t.name === "scheduleUpdate").bodyFields
      .find((f) => f.name === "schedule");
    assert.equal(field.shape, "Array<Array<{ start, end }>>");
    assert.equal(field.required, false);
    assert.equal("dates" in field, false, "dates must not reach the prompt");
    assert.equal("review" in field, false, "review must not reach the prompt");
  });

  test("a destructive query never happens; a destructive action is flagged in its line", () => {
    assert.match(opLine({ kind: "action", name: "x", requiresConfirmation: true }), /\[destructive\]/);
    assert.doesNotMatch(opLine({ kind: "query", name: "y" }), /destructive/);
  });

  test("confidence becomes a path marker on the line, and known carries none", () => {
    assert.match(opLine({ kind: "action", name: "a", confidence: "review" }), /\[screen first\]/);
    assert.match(opLine({ kind: "action", name: "a", confidence: "unknown" }), /\[screen only\]/);
    assert.doesNotMatch(opLine({ kind: "action", name: "a" }), /\[screen/);
    // A real screen flow is already the screen; it gets no path marker.
    assert.doesNotMatch(opLine({ kind: "action", name: "a", transport: "dom", confidence: "review" }), /\[screen first\]/);
  });

  test("expand carries the confidence directive on the tool", () => {
    const tool = expand(m, "availability/schedule").tools.find((t) => t.name === "scheduleUpdate");
    assert.equal(tool.confidence, "review");
  });
});

describe("a nested field shape reaches the catalog line", () => {
  test("an array-of-objects field shows its shape, a scalar does not", () => {
    const m = {
      queries: [],
      actions: [{
        name: "updateSchedule",
        description: "set hours",
        bodyFields: [
          { name: "scheduleId", required: true, type: "number" },
          { name: "schedule", required: false, type: "array", shape: "Array<Array<{ start, end }>>" },
        ],
      }],
    };
    const line = rootCatalog(m).split("\n").find((l) => /updateSchedule/.test(l));
    assert.match(line, /scheduleId,/);
    assert.match(line, /schedule\?: Array<Array<\{ start, end \}>>/);
  });
});
