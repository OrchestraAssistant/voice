import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { shapeMatches, generalize } from "./core/testidShapes.js";

describe("test-id shapes", () => {
  test("a shape matches any value that fits its holes", () => {
    assert.equal(shapeMatches("*-switch", "Sunday-switch"), true);
    assert.equal(shapeMatches("*-switch", "Domingo-switch"), true);
    assert.equal(shapeMatches("*-switch", "switch"), false, "* needs at least one char");
    assert.equal(shapeMatches("app-*-card", "app-slack-card"), true);
    assert.equal(shapeMatches("app-*-card", "app-card"), false);
  });

  test("a measured id becomes the template it was built from", () => {
    // The whole point: the probe sees Sunday-switch, the source has
    // ${weekday}-switch, and the stored marker should survive a locale change.
    const shapes = ["*-switch", "app-store-app-card-*"];
    assert.equal(generalize("Sunday-switch", shapes), "*-switch");
    assert.equal(generalize("Domingo-switch", shapes), "*-switch");
    assert.equal(generalize("app-store-app-card-slack", shapes), "app-store-app-card-*");
  });

  test("an id that fits no template keeps its own text", () => {
    // A genuinely literal marker was not built from a template; its own value
    // is the right thing to wait for.
    assert.equal(generalize("email", ["*-switch"]), "email");
    assert.equal(generalize("new-event-type", []), "new-event-type");
  });

  test("the most specific template wins", () => {
    // More literal characters = more specific = better marker.
    const shapes = ["*-item", "filter-*-item"];
    assert.equal(generalize("filter-status-item", shapes), "filter-*-item");
  });
});

import { testIdShapes, shapeFileCounts, componentSpread } from "./core/testidShapes.js";
import { repoRoot } from "./core/parse.js";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("harvesting shapes from source", () => {
  test("a shape needs a real stem, not just separators between holes", () => {
    // `${fieldName}-${variant}` collapses to `*-*`, which matches almost any
    // hyphenated id and would swallow markers that are not template instances.
    const dir = mkdtempSync(join(tmpdir(), "shapes-"));
    writeFileSync(join(dir, "a.tsx"), [
      "data-testid={`${weekday}-switch`}",
      "data-testid={`${fieldName}-${variant}`}",
      "data-testid={`app-store-app-card-${app.slug}`}",
      'data-testid="a-plain-literal"',
    ].join("\n"));
    const shapes = testIdShapes(dir);
    rmSync(dir, { recursive: true, force: true });
    assert.ok(shapes.includes("*-switch"), "kept a real stem");
    assert.ok(shapes.includes("app-store-app-card-*"), "kept a long stem");
    assert.ok(!shapes.includes("*-*"), "rejected the stemless shape");
    assert.ok(!shapes.some((s) => !s.includes("*")), "a plain literal is not a shape");
  });

  test("a template in a sibling package is only found from the monorepo root", () => {
    // The bug: cal.diy's `${weekday}-switch` lives in packages/features, but the
    // probe harvested from apps/web alone, so `Sunday-switch` never became
    // `*-switch`. repoRoot climbs to the workspace root, where a grep sees every
    // package.
    const root = mkdtempSync(join(tmpdir(), "mono-"));
    mkdirSync(join(root, "apps", "web", ".voice"), { recursive: true });
    mkdirSync(join(root, "packages", "features"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["apps/*", "packages/*"] }));
    writeFileSync(join(root, "apps", "web", "package.json"), "{}");
    writeFileSync(join(root, "packages", "features", "Schedule.tsx"), "data-testid={`${weekday}-switch`}");

    const appDir = join(root, "apps", "web");
    assert.equal(repoRoot(appDir), root, "climbs to the workspaces root");
    assert.ok(!testIdShapes(appDir).includes("*-switch"), "scoped to the app, the sibling template is invisible");
    assert.ok(testIdShapes(repoRoot(appDir)).includes("*-switch"), "from the root, it is found");
    assert.equal(generalize("Domingo-switch", testIdShapes(repoRoot(appDir))), "*-switch", "and generalises, locale and all");

    rmSync(root, { recursive: true, force: true });
  });

  test("a shape is scored by the files its template appears in, not its rendered value", () => {
    // The ranking penalised `Sunday-switch` because the literal is nowhere in
    // source -- only `${weekday}-switch` is. Counting the template gives the
    // shape a real, fair specificity.
    const dir = mkdtempSync(join(tmpdir(), "spread-"));
    writeFileSync(join(dir, "editor.tsx"), "data-testid={`${weekday}-switch`}");
    writeFileSync(join(dir, "list.tsx"), "data-testid={`${app.slug}-row`}\ndata-testid={`${app.slug}-row`}");
    const counts = shapeFileCounts(dir);
    rmSync(dir, { recursive: true, force: true });
    assert.equal(counts.get("*-switch"), 1, "template in one file");
    assert.equal(counts.get("*-row"), 1, "two hits in one file still counts one file");
  });

  test("a shared component's testId is scored by how widely the component is used", () => {
    // The bug: `pencil-icon`'s literal sits only in the icon definition, so the
    // grep called it unique though the component renders everywhere.
    const dir = mkdtempSync(join(tmpdir(), "comp-"));
    writeFileSync(join(dir, "icons.tsx"), 'export const PencilIcon = createIcon(Lucide, "pencil-icon");');
    writeFileSync(join(dir, "a.tsx"), "import { PencilIcon } from './icons';\n<PencilIcon/>");
    writeFileSync(join(dir, "b.tsx"), "import { PencilIcon } from './icons';\n<PencilIcon/>");
    writeFileSync(join(dir, "c.tsx"), "import { PencilIcon } from './icons';\n<PencilIcon/>");
    // A page-specific testId defined inline is NOT flagged.
    writeFileSync(join(dir, "page.tsx"), 'export function Page(){ return <div data-testid="locale-select"/> }');
    const pencil = componentSpread("pencil-icon", dir);
    const local = componentSpread("locale-select", dir);
    rmSync(dir, { recursive: true, force: true });
    assert.equal(pencil, 3, "PencilIcon is used in three files besides its definition");
    assert.ok(!local || local < 3, "an inline page testId is not counted as a shared component");
  });
});
