import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { reactRouterConfig } from "../../frameworks/react/routerConfig.js";

/** A throwaway source tree, returned as the srcDir the producer scans. */
function src(files) {
  const dir = mkdtempSync(join(tmpdir(), "rr-config-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}
const paths = (dir) => reactRouterConfig.run({ srcDir: dir }).routes.map((r) => r.path).sort();

describe("react-router config producer", () => {
  test("framework mode: route/index/layout/prefix with inline nesting", () => {
    const dir = src({
      "routes.ts": `
        import { route, index, layout, prefix } from "@react-router/dev/routes";
        export default [
          layout("./layout.tsx", [
            index("./home.tsx"),
            route("issues/:id", "./issue.tsx"),
            ...prefix("settings", [ route("members", "./members.tsx") ]),
            route("*", "./not-found.tsx"),
          ]),
        ];`,
    });
    assert.deepEqual(paths(dir), ["/", "/issues/:id", "/settings/members"]);
  });

  test("layout is pathless; nested route paths join under it", () => {
    const dir = src({
      "routes.ts": `
        import { route, layout } from "@react-router/dev/routes";
        export default [ layout("./shell.tsx", [ route("dashboard", "./d.tsx") ]) ];`,
    });
    assert.deepEqual(paths(dir), ["/dashboard"]);
  });

  test("the merged-array pattern across files: each route() is still collected", () => {
    // Plane's shape: routes.ts references arrays by identifier (unfollowable),
    // but the route() calls live in core.ts/extended.ts and are found there.
    const dir = src({
      "app/routes.ts": `
        import { layout, route } from "@react-router/dev/routes";
        import { coreRoutes } from "./routes/core";
        import { extendedRoutes } from "./routes/extended";
        import { mergeRoutes } from "./routes/helper";
        const merged = mergeRoutes(coreRoutes, extendedRoutes);
        export default [ layout("./layout.tsx", [...merged, route("*", "./not-found.tsx")]) ];`,
      "app/routes/core.ts": `
        import { route, index } from "@react-router/dev/routes";
        export const coreRoutes = [ index("./home.tsx"), route(":ws/projects", "./projects.tsx") ];`,
      "app/routes/extended.ts": `
        import { route } from "@react-router/dev/routes";
        export const extendedRoutes = [ route(":ws/settings", "./settings.tsx") ];`,
    });
    assert.deepEqual(paths(dir), ["/", "/:ws/projects", "/:ws/settings"]);
  });

  test("data router: createBrowserRouter objects with children and index", () => {
    const dir = src({
      "router.tsx": `
        import { createBrowserRouter } from "react-router-dom";
        export const router = createBrowserRouter([
          { path: "/tasks/:id", element: <Task/>, children: [
            { index: true, element: <Detail/> },
            { path: "edit", Component: EditTask },
          ] },
        ]);`,
    });
    assert.deepEqual(paths(dir), ["/tasks/:id", "/tasks/:id/edit"]);
  });

  test("component name is carried from element or module basename", () => {
    const dir = src({
      "r.tsx": `
        import { createBrowserRouter } from "react-router-dom";
        createBrowserRouter([{ path: "/a", element: <Alpha/> }]);`,
      "routes.ts": `
        import { route } from "@react-router/dev/routes";
        export default [ route("b", "./pages/beta.tsx") ];`,
    });
    const routes = reactRouterConfig.run({ srcDir: dir }).routes;
    assert.equal(routes.find((r) => r.path === "/a")?.component, "Alpha");
    assert.equal(routes.find((r) => r.path === "/b")?.component, "beta");
  });

  test("a bare route() in unrelated code is not mistaken for a route", () => {
    // `route` is an ordinary word; only an import from a react-router module
    // qualifies the call. No import here means no routes.
    const dir = src({
      "util.ts": `function route(x) { return x; } export const r = route("/nope");`,
    });
    assert.deepEqual(paths(dir), []);
  });

  test("catch-all and empty paths are dropped", () => {
    const dir = src({
      "routes.ts": `
        import { route } from "@react-router/dev/routes";
        export default [ route("*", "./nf.tsx"), route("ok", "./ok.tsx") ];`,
    });
    assert.deepEqual(paths(dir), ["/ok"]);
  });
});
