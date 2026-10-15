import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appMeta } from "../../stages/appMeta.js";
import { applyOverlay } from "../../core/overlay.js";

const root = (pkg) => {
  const dir = mkdtempSync(join(tmpdir(), "appmeta-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  return dir;
};

describe("app-meta seeds the app identity from package.json", () => {
  test("uses the description field", () => {
    assert.equal(appMeta.run({ root: root({ name: "shop", description: "An online storefront" }) }).description, "An online storefront");
  });
  test("no description -> nothing (the relay falls back, the pass fills it)", () => {
    assert.deepEqual(appMeta.run({ root: root({ name: "shop" }) }), {});
    assert.deepEqual(appMeta.run({ root: mkdtempSync(join(tmpdir(), "empty-")) }), {});
  });
});

describe("overlay top-level description", () => {
  const overlayFile = (obj) => {
    const p = join(mkdtempSync(join(tmpdir(), "ov-")), "manifest.overlay.json");
    writeFileSync(p, JSON.stringify(obj));
    return p;
  };
  test("a string description is returned so the judgement pass can refine the app identity", () => {
    const manifest = { routes: [], queries: [], actions: [] };
    assert.equal(applyOverlay(manifest, overlayFile({ description: "ShopCo: an artisanal storefront" })).description, "ShopCo: an artisanal storefront");
  });
  test("no description in the overlay returns null (so it cannot clobber the seed)", () => {
    assert.equal(applyOverlay({ routes: [], queries: [], actions: [] }, overlayFile({})).description, null);
  });
});
