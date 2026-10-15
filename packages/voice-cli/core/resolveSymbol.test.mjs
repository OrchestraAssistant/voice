import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageAliases, resolveSpecifier, findDefinition } from "./resolveSymbol.js";

/** A tiny fake monorepo: an app that re-exports a schema from a sibling package. */
function fixture() {
  const mono = mkdtempSync(join(tmpdir(), "mono-"));
  mkdirSync(join(mono, "apps", "web", "src"), { recursive: true });
  mkdirSync(join(mono, "packages", "features", "services"), { recursive: true });
  writeFileSync(join(mono, "packages", "features", "package.json"), JSON.stringify({ name: "@acme/features" }));
  // the real definition, two hops away and in another package
  writeFileSync(join(mono, "packages", "features", "services", "Schedule.ts"),
    'import { z } from "zod";\nexport const ZUpdate = z.object({ scheduleId: z.number(), name: z.string().optional() });\n');
  // a re-export barrel
  writeFileSync(join(mono, "packages", "features", "index.ts"),
    'export { ZUpdate } from "./services/Schedule";\n');
  // the app's router uses it via the package alias
  const routerFile = join(mono, "apps", "web", "src", "router.ts");
  writeFileSync(routerFile, 'import { ZUpdate } from "@acme/features";\nexport const r = ZUpdate;\n');
  return { mono, routerFile, appRoot: join(mono, "apps", "web") };
}

describe("cross-package symbol resolution", () => {
  test("package aliases come from each package's own name", () => {
    const { mono, appRoot } = fixture();
    const aliases = packageAliases(appRoot);
    assert.equal(aliases.get("@acme/features"), join(mono, "packages", "features"));
    rmSync(mono, { recursive: true, force: true });
  });

  test("a specifier resolves through an alias to a real file", () => {
    const { mono, routerFile, appRoot } = fixture();
    const aliases = packageAliases(appRoot);
    const f = resolveSpecifier("@acme/features", routerFile, aliases);
    assert.match(f, /packages\/features\/index\.ts$/);
    rmSync(mono, { recursive: true, force: true });
  });

  test("a symbol is followed across a re-export into another package", () => {
    // The exact shape that left cal's availabilityScheduleUpdate empty.
    const { mono, routerFile, appRoot } = fixture();
    const aliases = packageAliases(appRoot);
    const def = findDefinition("ZUpdate", routerFile, aliases);
    assert.ok(def, "did not resolve across the re-export");
    assert.match(def.file, /services\/Schedule\.ts$/);
    assert.equal(def.node.type, "CallExpression");
    assert.equal(def.node.callee.property.name, "object");
    rmSync(mono, { recursive: true, force: true });
  });

  test("a symbol is followed through an `export *` barrel", () => {
    // `export * from "./x"` lists no specifiers, so the resolver skipped it and
    // returned null -- a schema surfaced through a star barrel (the monorepo
    // norm) left its action's bodyFields empty and the model guessing.
    const mono = mkdtempSync(join(tmpdir(), "star-"));
    mkdirSync(join(mono, "packages", "features", "services"), { recursive: true });
    writeFileSync(join(mono, "packages", "features", "package.json"), JSON.stringify({ name: "@acme/features" }));
    writeFileSync(join(mono, "packages", "features", "services", "Schedule.ts"),
      'import { z } from "zod";\nexport const ZUpdate = z.object({ scheduleId: z.number() });\n');
    // a STAR barrel, not a named re-export
    writeFileSync(join(mono, "packages", "features", "index.ts"), 'export * from "./services/Schedule";\n');
    mkdirSync(join(mono, "apps", "web", "src"), { recursive: true });
    const routerFile = join(mono, "apps", "web", "src", "router.ts");
    writeFileSync(routerFile, 'import { ZUpdate } from "@acme/features";\nexport const r = ZUpdate;\n');

    const aliases = packageAliases(join(mono, "apps", "web"));
    const def = findDefinition("ZUpdate", routerFile, aliases);
    assert.ok(def, "did not resolve through the export * barrel");
    assert.match(def.file, /services\/Schedule\.ts$/);
    rmSync(mono, { recursive: true, force: true });
  });

  test("an unresolvable symbol is null, not a throw", () => {
    const { mono, routerFile, appRoot } = fixture();
    const aliases = packageAliases(appRoot);
    assert.equal(findDefinition("Nonexistent", routerFile, aliases), null);
    rmSync(mono, { recursive: true, force: true });
  });
});

import { zodBodies } from "../schema/zod.js";
import { mkdtempSync as mkd2, writeFileSync as wf2, mkdirSync as md2, rmSync as rm2 } from "node:fs";
import { tmpdir as tmp2 } from "node:os";
import { join as j2 } from "node:path";

describe("nested schema shapes", () => {
  test("an array-of-arrays-of-objects becomes a readable shape", () => {
    const dir = mkd2(j2(tmp2(), "zod-"));
    md2(dir, { recursive: true });
    wf2(j2(dir, "s.ts"),
      'import { z } from "zod";\n' +
      'export const ZUpd = z.object({\n' +
      '  scheduleId: z.number(),\n' +
      '  schedule: z.array(z.array(z.object({ start: z.date(), end: z.date() }))).optional(),\n' +
      '  name: z.string().min(1).optional(),\n' +
      '});\n');
    const actions = [{ name: "upd", _inputSchema: "ZUpd", _inputSchemaFile: j2(dir, "s.ts"), bodyFields: [] }];
    zodBodies.run({ srcDir: dir, root: dir, actions });
    rm2(dir, { recursive: true, force: true });

    const byName = Object.fromEntries(actions[0].bodyFields.map((f) => [f.name, f]));
    assert.equal(byName.scheduleId.type, "number");
    assert.equal(byName.scheduleId.required, true);
    assert.equal(byName.schedule.shape, "Array<Array<{ start, end }>>");
    assert.equal(byName.name.type, "string", "a wrapper name must not leak in as the type");
    assert.equal(byName.name.shape, undefined, "a scalar carries no shape");
  });
});
