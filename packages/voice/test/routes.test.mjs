import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveRoutePath, planNavigation, matchPattern, fillPattern } from "../src/routes.js";

const routes = [
  { path: "/", component: "Dashboard" },
  { path: "/tasks/new", component: "NewTask" },
  { path: "/tasks/:id", component: "TaskDetail" },
  { path: "/settings", component: "Settings" },
];

describe("resolveRoutePath", () => {
  test("the well-formed call still works", () => {
    assert.equal(resolveRoutePath({ path: "/settings" }, routes), "/settings");
    assert.equal(resolveRoutePath({ path: "/" }, routes), "/");
  });

  test("the route in the key instead of the value", () => {
    // Observed live, four times in one session, every one an error.
    assert.equal(resolveRoutePath({ "/": "settings" }, routes), "/settings");
    assert.equal(resolveRoutePath({ "/": "dashboard" }, routes), "/");
  });

  test("a component name resolves to its path", () => {
    // "dashboard" is "/", which no amount of string matching on the path finds.
    assert.equal(resolveRoutePath({ path: "dashboard" }, routes), "/");
    assert.equal(resolveRoutePath({ page: "Settings" }, routes), "/settings");
  });

  test("a missing leading slash", () => {
    assert.equal(resolveRoutePath({ path: "settings" }, routes), "/settings");
  });

  test("a parameterised route is allowed through unrecognised", () => {
    // /tasks/3 is legitimate and will never be in the list literally.
    assert.equal(resolveRoutePath({ path: "/tasks/3" }, routes), "/tasks/3");
  });

  test("nothing usable returns null rather than a guess", () => {
    assert.equal(resolveRoutePath({}, routes), null);
    assert.equal(resolveRoutePath({ id: 4 }, routes), null);
    assert.equal(resolveRoutePath(undefined, routes), null);
  });

  test("`path` wins when both are present", () => {
    assert.equal(resolveRoutePath({ path: "/settings", other: "dashboard" }, routes), "/settings");
  });
});

// Plane-shaped routes: everything is scoped under a workspace slug, and some
// pages need an id the current url does not carry.
const planeRoutes = [
  { path: "/:workspaceSlug" },
  { path: "/:workspaceSlug/projects" },
  { path: "/:workspaceSlug/projects/:projectId/issues" },
  { path: "/:workspaceSlug/profile/:userId" },
  { path: "/create-workspace" },
  { path: "/*" },
];

describe("matchPattern / fillPattern", () => {
  test("binds a concrete url to a pattern, ignoring a trailing slash", () => {
    assert.deepEqual(matchPattern("/:workspaceSlug", "/field-test/"), { workspaceSlug: "field-test" });
    assert.deepEqual(matchPattern("/:workspaceSlug/projects", "/field-test/projects"), { workspaceSlug: "field-test" });
  });
  test("a length or literal mismatch, or a catch-all, does not match", () => {
    assert.equal(matchPattern("/:workspaceSlug/projects", "/field-test"), null);
    assert.equal(matchPattern("/settings", "/field-test"), null);
    assert.equal(matchPattern("/*", "/anything"), null, "a catch-all must not bind");
  });
  test("fill reports the holes left open", () => {
    assert.deepEqual(fillPattern("/:a/x/:b", { a: "1" }), { path: "/1/x/:b", missing: ["b"] });
    assert.deepEqual(fillPattern("/:a/x/:b", { a: "1", b: "2" }), { path: "/1/x/2", missing: [] });
  });
});

describe("planNavigation", () => {
  test("a flat route needs no filling", () => {
    assert.deepEqual(planNavigation({ path: "/create-workspace" }, planeRoutes, "/field-test/"), { path: "/create-workspace" });
  });

  test("the workspace slug is reused from the current url for free", () => {
    // "go to projects" from inside a workspace: the model names the route, the
    // widget fills :workspaceSlug from where the user already is.
    const plan = planNavigation({ path: "/:workspaceSlug/projects" }, planeRoutes, "/field-test/");
    assert.deepEqual(plan, { path: "/field-test/projects" });
  });

  test("an id the model resolved is taken from its args; the slug still from the url", () => {
    const plan = planNavigation(
      { path: "/:workspaceSlug/projects/:projectId/issues", projectId: "abc-123" },
      planeRoutes,
      "/field-test/projects",
    );
    assert.deepEqual(plan, { path: "/field-test/projects/abc-123/issues" });
  });

  test("a param neither the url nor the args fills is REFUSED, not navigated", () => {
    // "show me my work" -> /:workspaceSlug/profile/:userId. The slug is free,
    // but no query returns the current userId, so this must refuse rather than
    // send /field-test/profile/:userId to the router.
    const plan = planNavigation({ path: "/:workspaceSlug/profile/:userId" }, planeRoutes, "/field-test/");
    assert.deepEqual(plan, { pattern: "/:workspaceSlug/profile/:userId", missing: ["userId"] });
  });

  test("params passed under a nested `params` object are honoured", () => {
    const plan = planNavigation(
      { path: "/:workspaceSlug/profile/:userId", params: { userId: "me-42" } },
      planeRoutes,
      "/field-test/",
    );
    assert.deepEqual(plan, { path: "/field-test/profile/me-42" });
  });
});
