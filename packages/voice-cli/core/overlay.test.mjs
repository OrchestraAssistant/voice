import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOverlay } from "./overlay.js";

/** Write an overlay object to a temp file and return its path. */
function overlayFile(obj) {
  const path = join(mkdtempSync(join(tmpdir(), "overlay-")), "manifest.overlay.json");
  writeFileSync(path, JSON.stringify(obj));
  return path;
}

describe("applyOverlay", () => {
  test("patches a route description by path, merging only the given field", () => {
    const manifest = { routes: [{ path: "/x", component: "X" }], queries: [], actions: [] };
    applyOverlay(manifest, overlayFile({ routes: [{ path: "/x", description: "the X page" }] }));
    assert.deepEqual(manifest.routes[0], { path: "/x", component: "X", description: "the X page" });
  });

  test("drop: true removes a matched route -- pruning a non-destination", () => {
    const manifest = {
      routes: [{ path: "/projects" }, { path: "/*" }, { path: "/login" }],
      queries: [],
      actions: [],
    };
    const { applied } = applyOverlay(
      manifest,
      overlayFile({ routes: [{ path: "/*", drop: true }, { path: "/login", drop: true }] }),
    );
    assert.deepEqual(manifest.routes.map((r) => r.path), ["/projects"]);
    assert.ok(applied.includes("-route /*") && applied.includes("-route /login"));
  });

  test("drop: true also prunes an endpoint that should not ship", () => {
    const manifest = { routes: [], queries: [{ name: "internalPing" }], actions: [] };
    applyOverlay(manifest, overlayFile({ queries: [{ name: "internalPing", drop: true }] }));
    assert.equal(manifest.queries.length, 0);
  });

  test("a drop that matches nothing is reported, not silently ignored", () => {
    const manifest = { routes: [{ path: "/a" }], queries: [], actions: [] };
    const { unmatched } = applyOverlay(manifest, overlayFile({ routes: [{ path: "/gone", drop: true }] }));
    assert.ok(unmatched.some((u) => /\/gone/.test(u) && /drop/.test(u)));
    assert.equal(manifest.routes.length, 1, "an unmatched drop must not remove anything");
  });

  test("a patch for an item the detectors missed is added", () => {
    const manifest = { routes: [], queries: [], actions: [] };
    applyOverlay(manifest, overlayFile({ actions: [{ name: "handMade", method: "POST" }] }));
    assert.equal(manifest.actions[0].name, "handMade");
  });

  test("include narrows queries/actions but leaves routes alone", () => {
    const manifest = {
      routes: [{ path: "/a" }, { path: "/b" }],
      queries: [{ name: "keep" }, { name: "toss" }],
      actions: [],
    };
    applyOverlay(manifest, overlayFile({ include: ["keep"] }));
    assert.deepEqual(manifest.queries.map((q) => q.name), ["keep"]);
    assert.equal(manifest.routes.length, 2, "include is tool-only; routes are pruned with drop");
  });
});
