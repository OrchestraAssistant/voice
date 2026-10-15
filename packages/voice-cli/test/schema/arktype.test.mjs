import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { arktypeBodies } from "../../schema/arktype.js";

function src(files) {
  const dir = mkdtempSync(join(tmpdir(), "arktype-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}
const action = (name, params = []) => ({ name, method: "POST", params, bodyFields: [] });
const byName = (fields) => Object.fromEntries(fields.map((f) => [f.name, f]));

describe("arktype enricher", () => {
  test("reads string type-expressions, key-based optionality, unions and arrays", () => {
    const dir = src({
      "schema.ts": `import { type } from "arktype";
        export const CreateTask = type({
          name: "string",
          "count?": "number",
          priority: "'low' | 'high'",
          tags: "string[]",
          done: "boolean",
        });`,
    });
    const actions = [action("createTask")];
    arktypeBodies.run({ srcDir: dir, actions });
    const f = byName(actions[0].bodyFields);
    assert.equal(f.name.type, "string");
    assert.equal(f.name.required, true);
    assert.equal(f.count.required, false, "trailing ? on the key means optional");
    assert.equal(f.count.type, "number");
    assert.equal(f.priority.type, "enum");
    assert.deepEqual(f.priority.enumValues, ["low", "high"]);
    assert.equal(f.tags.type, "array");
    assert.equal(f.done.type, "boolean");
  });

  test("only fires when `type` comes from arktype (tracks the local alias)", () => {
    const aliased = src({
      "s.ts": `import { type as t } from "arktype"; export const XInput = t({ a: "string" });`,
    });
    const a1 = [action("x")];
    arktypeBodies.run({ srcDir: aliased, actions: a1 });
    assert.equal(a1[0].bodyFields.length, 1, "aliased arktype import not tracked");

    const notArktype = src({
      "s.ts": `function type(x){return x;} export const XInput = type({ a: "string" });`,
    });
    const a2 = [action("x")];
    arktypeBodies.run({ srcDir: notArktype, actions: a2 });
    assert.equal(a2[0].bodyFields.length, 0, "a non-arktype type() was mistaken for a schema");
  });

  test("url params are not repeated in the body", () => {
    const dir = src({
      "s.ts": `import { type } from "arktype";
        export const UpdateTask = type({ id: "string", title: "string" });`,
    });
    const actions = [action("updateTask", [{ name: "id", source: "url" }])];
    arktypeBodies.run({ srcDir: dir, actions });
    assert.deepEqual(actions[0].bodyFields.map((f) => f.name), ["title"]);
  });
});
