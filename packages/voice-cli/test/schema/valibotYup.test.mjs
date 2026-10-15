import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { valibotBodies } from "../../schema/valibot.js";
import { yupBodies } from "../../schema/yup.js";

function src(files) {
  const dir = mkdtempSync(join(tmpdir(), "schema-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}
/** A bodyless write action, as a producer would leave it. */
const action = (name) => ({ name, method: "POST", params: [], bodyFields: [] });
const byName = (fields) => Object.fromEntries(fields.map((f) => [f.name, f]));

describe("valibot enricher", () => {
  test("reads types through optional/nullish/pipe and picklist", () => {
    const dir = src({
      "schema.ts": `import * as v from "valibot";
        export const CreateTaskSchema = v.object({
          title: v.pipe(v.string(), v.minLength(1)),
          count: v.number(),
          priority: v.optional(v.picklist(["low", "high"])),
          done: v.nullish(v.boolean()),
        });`,
    });
    const actions = [action("createTask")];
    valibotBodies.run({ srcDir: dir, actions });
    const f = byName(actions[0].bodyFields);
    assert.equal(f.title.type, "string");
    assert.equal(f.title.required, true);
    assert.equal(f.count.type, "number");
    assert.equal(f.priority.type, "enum");
    assert.deepEqual(f.priority.enumValues, ["low", "high"]);
    assert.equal(f.priority.required, false);
    assert.equal(f.done.required, false);
  });

  test("does not touch an action that already has a body", () => {
    const dir = src({ "s.ts": `import * as v from "valibot"; export const XSchema = v.object({ a: v.string() });` });
    const actions = [{ name: "x", bodyFields: [{ name: "existing", type: "string", required: true }] }];
    valibotBodies.run({ srcDir: dir, actions });
    assert.deepEqual(actions[0].bodyFields.map((f) => f.name), ["existing"]);
  });
});

describe("yup enricher", () => {
  test("required is opt-in via .required(); oneOf is an enum", () => {
    const dir = src({
      "schema.ts": `import * as yup from "yup";
        export const CreateTaskSchema = yup.object({
          title: yup.string().required(),
          note: yup.string(),
          priority: yup.string().oneOf(["low", "high"]).required(),
          count: yup.number(),
        });`,
    });
    const actions = [action("createTask")];
    yupBodies.run({ srcDir: dir, actions });
    const f = byName(actions[0].bodyFields);
    assert.equal(f.title.required, true);
    assert.equal(f.note.required, false, "yup fields are optional unless .required()");
    assert.equal(f.priority.type, "enum");
    assert.deepEqual(f.priority.enumValues, ["low", "high"]);
    assert.equal(f.priority.required, true);
    assert.equal(f.count.type, "number");
  });

  test("handles the object().shape({...}) spelling", () => {
    const dir = src({
      "schema.ts": `import { object, string } from "yup";
        export const SignupSchema = object().shape({ email: string().required() });`,
    });
    const actions = [action("signup")];
    yupBodies.run({ srcDir: dir, actions });
    assert.deepEqual(actions[0].bodyFields.map((f) => f.name), ["email"]);
    assert.equal(actions[0].bodyFields[0].required, true);
  });

  test("url params are not repeated as body fields", () => {
    const dir = src({
      "schema.ts": `import * as yup from "yup";
        export const UpdateTaskSchema = yup.object({ id: yup.string(), title: yup.string().required() });`,
    });
    const actions = [{ name: "updateTask", method: "PATCH", params: [{ name: "id", source: "url" }], bodyFields: [] }];
    yupBodies.run({ srcDir: dir, actions });
    assert.deepEqual(actions[0].bodyFields.map((f) => f.name), ["title"]);
  });
});
