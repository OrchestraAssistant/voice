import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = resolve(pkgDir, "dist/voice.js");

/**
 * The package has to be IMPORTABLE where there is no DOM, even though it is
 * useless there. Half the React apps in the world render on a server first,
 * and a module-scope `window` throws while the module graph is being built --
 * before any component renders, so no amount of `ssr: false` at the call site
 * saves it.
 *
 * This runs against dist/, not src/. The fault that prompted it was invisible
 * in every other test we have: the browser tests have a DOM by definition, and
 * the unit tests import individual source modules rather than the bundle.
 */
describe("importable without a DOM", () => {
  test("the built bundle evaluates in bare node", async () => {
    // Observed: "window is not defined" from a native value setter read at
    // module scope, which made the package unimportable in Next.js entirely.
    const mod = await import(bundle);
    assert.ok(mod.VoiceProvider, "the entry point did not survive evaluation");
    assert.ok(mod.InterpreterBubble);
  });

  test("the native value setters are read on use, not on load", () => {
    // The specific fault, asserted at the source so a regression says WHAT
    // broke rather than only that something threw. A text scan of the bundle
    // was the first attempt and it could not tell guarded access inside a
    // function from the module-scope kind, so it failed on correct code.
    const dom = readFileSync(resolve(pkgDir, "src/domActions.js"), "utf8");
    assert.match(dom, /nativeValueSetters \?\?=/, "the setters are not lazily initialised");
    assert.doesNotMatch(dom, /^const NATIVE_VALUE_SETTERS = \{/m, "back to reading them at module scope");
  });

});

describe("what a consumer can resolve", () => {
  const pkg = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8"));

  test("the entry point is reachable however the consumer asks", () => {
    // An "import"-only condition means any resolver that does not ask for
    // `import` -- a bundler probing conditions, a CJS require -- gets
    // ERR_PACKAGE_PATH_NOT_EXPORTED and no useful message.
    assert.ok(pkg.exports["."].default, "no default condition on the main entry");
  });

  test("package.json is exported, because tools read it", () => {
    // Bundlers and type resolvers look it up by subpath; an exports map that
    // omits it makes them fail rather than fall back.
    assert.equal(pkg.exports["./package.json"], "./package.json");
  });

  test("the stylesheet is a separate entry, exported as inline.css not styles.css", () => {
    // Named inline.css on purpose: the default shadow mount needs no CSS import,
    // and a reflexive `import "@expert/voice/styles.css"` should fail loudly
    // rather than leak the sheet into a Tailwind host and break its layout.
    assert.equal(pkg.exports["./inline.css"], "./dist/voice.css");
    assert.equal(pkg.exports["./styles.css"], undefined, "styles.css must NOT resolve");
  });
});
