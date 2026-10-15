import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { stampVersion, contractHash, contractDiff, MANIFEST_FORMAT_VERSION } from "./manifestVersion.js";

const base = () => ({
  description: "A task app",
  routes: [{ path: "/", component: "Home" }, { path: "/tasks/:id", component: "Task" }],
  queries: [{ name: "tasks", method: "GET", endpoint: "/api/tasks", description: "list", callSites: 3, params: [] }],
  actions: [
    {
      name: "createTask",
      method: "POST",
      endpoint: "/api/tasks",
      description: "make one",
      requiresConfirmation: false,
      params: [],
      bodyFields: [{ name: "title", required: true, type: "string" }],
    },
  ],
});

describe("manifest versioning", () => {
  test("stampVersion adds version + contractHash and is idempotent", () => {
    const once = stampVersion(base());
    assert.equal(once.version, MANIFEST_FORMAT_VERSION);
    assert.match(once.contractHash, /^[0-9a-f]{16}$/);
    const twice = stampVersion(once);
    assert.equal(twice.contractHash, once.contractHash, "re-stamping does not change the hash");
    assert.equal(twice.version, once.version);
  });

  test("cosmetic changes do NOT change the contractHash", () => {
    const h = contractHash(base());
    const reworded = base();
    reworded.description = "Totally different prose";
    reworded.queries[0].description = "a reworded description";
    reworded.actions[0].callSites = 999;
    reworded.generatedBy = ["whatever"];
    assert.equal(contractHash(reworded), h, "description/callSites/stamp are not contract");

    // key order and array order of params/body must not matter
    const reordered = base();
    reordered.actions[0].bodyFields.unshift({ type: "string", name: "notes", required: false });
    const reordered2 = base();
    reordered2.actions[0].bodyFields.push({ name: "notes", required: false, type: "string" });
    assert.equal(contractHash(reordered), contractHash(reordered2), "body field order does not matter");
  });

  test("callable-surface changes DO change the contractHash", () => {
    const h = contractHash(base());

    const renamed = base();
    renamed.actions[0].name = "addTask";
    assert.notEqual(contractHash(renamed), h, "renaming an operation");

    const moved = base();
    moved.actions[0].endpoint = "/api/v2/tasks";
    assert.notEqual(contractHash(moved), h, "moving an endpoint");

    const gated = base();
    gated.actions[0].requiresConfirmation = true;
    assert.notEqual(contractHash(gated), h, "flipping a confirmation tier");

    const extraField = base();
    extraField.actions[0].bodyFields.push({ name: "priority", required: true, type: "number" });
    assert.notEqual(contractHash(extraField), h, "a new required body field");

    const extraRoute = base();
    extraRoute.routes.push({ path: "/settings" });
    assert.notEqual(contractHash(extraRoute), h, "a new route");
  });

  test("contractDiff reports added and removed operations", () => {
    const before = base();
    const after = base();
    after.actions.push({ name: "deleteTask", method: "DELETE", endpoint: "/api/tasks/:id", requiresConfirmation: true });
    after.queries = [];
    const { added, removed } = contractDiff(before, after);
    assert.ok(added.includes("action deleteTask"));
    assert.ok(removed.includes("query tasks"));
  });
});
