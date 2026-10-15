import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openapiSpec } from "../../frameworks/openapi/spec.js";

function src(files) {
  const dir = mkdtempSync(join(tmpdir(), "openapi-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

const SPEC = {
  openapi: "3.0.0",
  servers: [{ url: "https://api.example.com/v1" }],
  paths: {
    "/pets": {
      get: { operationId: "listPets", parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }] },
      post: {
        operationId: "createPet",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/PetCreate" } } } },
      },
    },
    "/pets/{id}": {
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      patch: {
        operationId: "updatePet",
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/PetUpdate" } } } },
      },
      delete: { operationId: "deletePet" },
    },
  },
  components: {
    schemas: {
      PetCreate: {
        type: "object",
        required: ["name"],
        properties: {
          id: { type: "string", readOnly: true },
          name: { type: "string" },
          status: { type: "string", enum: ["available", "sold"] },
          age: { type: "integer" },
        },
      },
      PetUpdate: { allOf: [{ $ref: "#/components/schemas/PetCreate" }, { type: "object", properties: { note: { type: "string" } } }] },
    },
  },
};

describe("openapi-spec producer", () => {
  test("paths become operations; server base path is prepended", () => {
    const { queries, actions } = openapiSpec.run({ srcDir: src({ "openapi.json": SPEC }) });
    assert.deepEqual(queries.map((q) => q.name), ["listPets"]);
    assert.deepEqual(actions.map((a) => a.name).sort(), ["createPet", "deletePet", "updatePet"]);
    const list = queries[0];
    assert.equal(list.endpoint, "/v1/pets");
    assert.equal(list.method, "GET");
    assert.deepEqual(list.params, [{ name: "limit", type: "number", required: false, source: "query-string" }]);
  });

  test("request body is typed from a $ref schema; readOnly fields are dropped", () => {
    const { actions } = openapiSpec.run({ srcDir: src({ "swagger.json": SPEC }) });
    const create = actions.find((a) => a.name === "createPet");
    const byName = Object.fromEntries(create.bodyFields.map((f) => [f.name, f]));
    assert.deepEqual(Object.keys(byName).sort(), ["age", "name", "status"]); // id is readOnly -> excluded
    assert.equal(byName.name.required, true);
    assert.equal(byName.age.type, "number");
    assert.equal(byName.status.type, "enum");
    assert.deepEqual(byName.status.enumValues, ["available", "sold"]);
  });

  test("allOf schemas are merged; path params are shared across a path's methods", () => {
    const { actions } = openapiSpec.run({ srcDir: src({ "openapi.json": SPEC }) });
    const update = actions.find((a) => a.name === "updatePet");
    assert.equal(update.method, "PATCH");
    assert.deepEqual(update.params, [{ name: "id", type: "string", required: true, source: "url" }]);
    // allOf(PetCreate, {note}) -> name/status/age + note, id still dropped.
    assert.ok(update.bodyFields.some((f) => f.name === "note"));
    assert.ok(update.bodyFields.some((f) => f.name === "name"));
    assert.ok(!update.bodyFields.some((f) => f.name === "id"));
    assert.equal(actions.find((a) => a.name === "deletePet").requiresConfirmation, true);
  });

  test("a JSON file that is not a spec is ignored", () => {
    const { queries, actions } = openapiSpec.run({
      srcDir: src({ "package.json": '{"name":"x"}', "data/openapi.json": '{"not":"a spec"}' }),
    });
    assert.equal(queries.length + actions.length, 0);
  });

  test("operationId is normalised; falls back to method+path when absent", () => {
    const { queries } = openapiSpec.run({
      srcDir: src({
        "openapi.json": {
          openapi: "3.0.0",
          paths: {
            "/a/b": { get: { operationId: "Pets_list_all" } },
            "/c/{id}": { get: {} },
          },
        },
      }),
    });
    const names = queries.map((q) => q.name).sort();
    assert.ok(names.includes("petsListAll"), `operationId not normalised: ${names}`);
    assert.ok(names.includes("cById"), `fallback name missing: ${names}`);
  });

  test("an enum QUERY parameter keeps its values (not just body fields)", () => {
    const spec = JSON.stringify({
      openapi: "3.0.0",
      paths: {
        "/pets": {
          get: {
            operationId: "listPets",
            parameters: [{ name: "status", in: "query", schema: { type: "string", enum: ["available", "sold"] } }],
          },
        },
      },
    });
    const { queries } = openapiSpec.run({ srcDir: src({ "openapi.json": spec }) });
    const status = queries.find((q) => q.name === "listPets").params.find((p) => p.name === "status");
    assert.equal(status.type, "enum");
    assert.deepEqual(status.enumValues, ["available", "sold"]);
  });

});
