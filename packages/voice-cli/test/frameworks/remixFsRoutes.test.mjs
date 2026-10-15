import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { remixFsRoutes } from "../../frameworks/remix/fsRoutes.js";

function app(files) {
  const root = mkdtempSync(join(tmpdir(), "remix-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body ?? "export default function R(){}");
  }
  return root;
}
const REMIX_PKG = '{"dependencies":{"@remix-run/react":"^2.0.0"}}';
const paths = (root) => remixFsRoutes.run({ root }).routes.map((r) => r.path).sort();

describe("remix-fs-routes producer", () => {
  test("only applies to a Remix / fs-routes app", () => {
    const remix = app({ "package.json": REMIX_PKG, "app/routes/about.tsx": "" });
    const plain = app({ "package.json": '{"dependencies":{"react-router":"^6"}}', "app/routes/about.tsx": "" });
    assert.equal(remixFsRoutes.applies({ root: remix }), true);
    assert.equal(remixFsRoutes.applies({ root: plain }), false);
    // A remix.config file is signal enough on its own.
    assert.equal(remixFsRoutes.applies({ root: app({ "remix.config.js": "export default {}" }) }), true);
  });

  test("v2 flat routes: dots are segments, $ is a param, _ is pathless", () => {
    const root = app({
      "package.json": REMIX_PKG,
      "app/routes/_index.tsx": "",
      "app/routes/about.tsx": "",
      "app/routes/blog.$slug.tsx": "",
      "app/routes/users.$userId.posts.tsx": "",
      "app/routes/_auth.login.tsx": "",
      "app/routes/users_.profile.tsx": "",
    });
    assert.deepEqual(paths(root), [
      "/",
      "/about",
      "/blog/:slug",
      "/login",
      "/users/:userId/posts",
      "/users/profile",
    ]);
  });

  test("bracket escapes a literal; splats are dropped", () => {
    const root = app({
      "package.json": REMIX_PKG,
      "app/routes/sitemap[.]xml.tsx": "",
      "app/routes/$.tsx": "",
      "app/routes/files.$.tsx": "",
      "app/routes/ok.tsx": "",
    });
    assert.deepEqual(paths(root), ["/ok", "/sitemap.xml"]);
  });

  test("v2 folder form (route.tsx) and v1 nesting (folders + index) both resolve", () => {
    const root = app({
      "package.json": REMIX_PKG,
      "app/routes/concerts.$city/route.tsx": "",
      "app/routes/blog/$slug.tsx": "",
      "app/routes/blog/index.tsx": "",
    });
    assert.deepEqual(paths(root), ["/blog", "/blog/:slug", "/concerts/:city"]);
  });

  test("non-route modules are ignored", () => {
    const root = app({
      "package.json": REMIX_PKG,
      "app/routes/about.tsx": "",
      "app/routes/about.server.ts": "",
      "app/routes/styles.css": "",
      "app/routes/queue.client.ts": "",
    });
    assert.deepEqual(paths(root), ["/about"]);
  });
});
