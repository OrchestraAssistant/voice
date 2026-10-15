import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { astroPages } from "../../frameworks/astro/pages.js";

function app(files) {
  const root = mkdtempSync(join(tmpdir(), "astro-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body ?? "");
  }
  return root;
}
const ASTRO = { "astro.config.mjs": "export default {}" };

describe("astro-pages producer", () => {
  test("only applies to an Astro app", () => {
    assert.equal(astroPages.applies({ root: app({ ...ASTRO, "src/pages/index.astro": "" }) }), true);
    assert.equal(astroPages.applies({ root: app({ "package.json": '{"dependencies":{"astro":"^4"}}' }) }), true);
    assert.equal(astroPages.applies({ root: app({ "src/pages/index.astro": "" }) }), false);
  });

  test("pages become navigation routes; [param] -> :param, catch-all dropped", () => {
    const root = app({
      ...ASTRO,
      "src/pages/index.astro": "",
      "src/pages/about.astro": "",
      "src/pages/blog/[slug].astro": "",
      "src/pages/docs/[...path].astro": "",
      "src/pages/post.md": "",
    });
    const { routes } = astroPages.run({ root });
    assert.deepEqual(routes.map((r) => r.path).sort(), ["/", "/about", "/blog/:slug", "/post"]);
  });

  test("endpoint modules become HTTP operations from their exported verbs", () => {
    const root = app({
      ...ASTRO,
      "src/pages/api/users/index.ts": "export function GET() {} export const POST = () => {};",
      "src/pages/api/users/[id].ts": "export function GET() {} export function DELETE() {}",
    });
    const { queries, actions } = astroPages.run({ root });
    const q = queries.find((x) => x.endpoint === "/api/users");
    assert.ok(q && q.method === "GET");
    const post = actions.find((a) => a.endpoint === "/api/users" && a.method === "POST");
    assert.ok(post);
    const byId = queries.find((x) => x.endpoint === "/api/users/{id}");
    assert.deepEqual(byId.params, [{ name: "id", type: "string", required: true, source: "url" }]);
    const del = actions.find((a) => a.endpoint === "/api/users/{id}" && a.method === "DELETE");
    assert.equal(del.requiresConfirmation, true);
  });

  test("a plain .ts helper in pages/ (no verb exports) is not an endpoint", () => {
    const root = app({ ...ASTRO, "src/pages/utils.ts": "export const clamp = (n) => n;" });
    const { queries, actions } = astroPages.run({ root });
    assert.equal(queries.length + actions.length, 0);
  });
});
