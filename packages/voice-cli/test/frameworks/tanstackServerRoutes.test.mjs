import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tanstackServerRoutes } from "../../frameworks/tanstack/serverRoutes.js";

function src(files) {
  const dir = mkdtempSync(join(tmpdir(), "ts-start-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

describe("tanstack-server-routes producer", () => {
  test("createAPIFileRoute('/path')({ GET, POST }) -> HTTP operations", () => {
    const dir = src({
      "routes/api/users.$id.ts": `import { createAPIFileRoute } from "@tanstack/react-start/api";
        export const Route = createAPIFileRoute('/api/users/$id')({
          GET: async ({ params }) => new Response("ok"),
          DELETE: async () => new Response(null),
        });`,
    });
    const { queries, actions } = tanstackServerRoutes.run({ srcDir: dir });
    const q = queries.find((x) => x.endpoint === "/api/users/{id}");
    assert.ok(q && q.method === "GET");
    assert.deepEqual(q.params, [{ name: "id", type: "string", required: true, source: "url" }]);
    const del = actions.find((a) => a.method === "DELETE");
    assert.ok(del && del.requiresConfirmation);
  });

  test("the newer createServerFileRoute('/path').methods({...}) spelling", () => {
    const dir = src({
      "routes/api/todos.ts": `import { createServerFileRoute } from "@tanstack/react-start/server";
        export const ServerRoute = createServerFileRoute('/api/todos').methods({
          GET: async () => new Response("[]"),
          POST: async () => new Response("{}"),
        });`,
    });
    const { queries, actions } = tanstackServerRoutes.run({ srcDir: dir });
    assert.ok(queries.some((q) => q.endpoint === "/api/todos" && q.method === "GET"));
    assert.ok(actions.some((a) => a.endpoint === "/api/todos" && a.method === "POST"));
  });

  test("no @tanstack/*start import means it does not fire", () => {
    const dir = src({
      "r.ts": `function createAPIFileRoute(){return ()=>{};}
        export const R = createAPIFileRoute('/api/x')({ GET: () => {} });`,
    });
    const { queries, actions } = tanstackServerRoutes.run({ srcDir: dir });
    assert.equal(queries.length + actions.length, 0);
  });

  test("a file-convention route with no explicit path arg is left alone", () => {
    const dir = src({
      "routes/api/x.ts": `import { createServerFileRoute } from "@tanstack/react-start/server";
        export const ServerRoute = createServerFileRoute().methods({ GET: () => {} });`,
    });
    const { queries, actions } = tanstackServerRoutes.run({ srcDir: dir });
    assert.equal(queries.length + actions.length, 0);
  });
});
