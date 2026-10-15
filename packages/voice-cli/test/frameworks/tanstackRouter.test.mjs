import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { tanstackRouter } from "../../frameworks/tanstack/router.js";

function src(files) {
  const dir = mkdtempSync(join(tmpdir(), "tanstack-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}
const routes = (dir) => tanstackRouter.run({ srcDir: dir }).routes;
const paths = (dir) => routes(dir).map((r) => r.path).sort();

describe("tanstack-router producer", () => {
  test("file style: createFileRoute paths, $param normalised to :param", () => {
    const dir = src({
      "routes/posts.$postId.tsx": `import { createFileRoute } from "@tanstack/react-router";
        export const Route = createFileRoute('/posts/$postId')({ component: Post });`,
      "routes/index.tsx": `import { createFileRoute } from "@tanstack/react-router";
        export const Route = createFileRoute('/')({ component: Home });`,
      "routes/files.splat.tsx": `import { createFileRoute } from "@tanstack/react-router";
        export const Route = createFileRoute('/files/$')({ component: Files });`,
    });
    assert.deepEqual(paths(dir), ["/", "/posts/:postId"]); // splat dropped
    assert.equal(routes(dir).find((r) => r.path === "/posts/:postId").component, "Post");
  });

  test("code style: createRoute({ path, component })", () => {
    const dir = src({
      "app.ts": `import { createRoute } from "@tanstack/react-router";
        const postsRoute = createRoute({ getParentRoute: () => root, path: '/posts', component: Posts });
        const oneRoute = createRoute({ getParentRoute: () => root, path: '/posts/$postId' });`,
    });
    assert.deepEqual(paths(dir), ["/posts", "/posts/:postId"]);
  });

  test("only fires on a @tanstack/*-router import (alias tracked)", () => {
    const aliased = src({
      "r.tsx": `import { createFileRoute as f } from "@tanstack/react-router";
        export const Route = f('/x')({ component: X });`,
    });
    assert.deepEqual(paths(aliased), ["/x"]);

    const notTanstack = src({
      "r.tsx": `function createFileRoute(p){return ()=>{};} export const R = createFileRoute('/nope')({});`,
    });
    assert.deepEqual(paths(notTanstack), []);
  });

  test("the root route is not a navigable path", () => {
    const dir = src({
      "root.tsx": `import { createRootRoute } from "@tanstack/react-router";
        export const Route = createRootRoute({ component: Root });`,
    });
    assert.deepEqual(paths(dir), []);
  });
});
