import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Assertions on the COMPILED stylesheet, which is what ships. They need no
 * browser and cost milliseconds, and they fail closer to the cause than the
 * behavioural tests do: a broken theme mapping shows up here as a missing
 * substring rather than there as a transparent panel.
 */
const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/voice.css");

let css;
try {
  css = readFileSync(dist, "utf8");
} catch {
  throw new Error(`${dist} is missing. Run \`npm run build:pkg\` first.`);
}

describe("compiled stylesheet", () => {
  test("semantic tokens are inlined into the utilities", () => {
    // `@theme inline` pastes the value into the utility, so the lookup happens
    // at the use site, inside our subtree where --iv-* is defined. A plain
    // @theme emits `var(--color-background)` here and resolves it against
    // :root, where --iv-surface does not exist -- which computes to the
    // guaranteed-invalid value and renders as transparent, silently.
    // `[^{]*` because the minifier merges selector lists, so this rule ships as
    // `.bg-background,.bg-background\/80{...}`. Matching the exact selector was
    // brittle for no benefit: what matters is the declaration.
    assert.match(css, /\.bg-background[^{]*\{background-color:var\(--iv-surface\)\}/);
    assert.match(css, /\.text-muted-foreground[^{]*\{color:var\(--iv-muted\)\}/);
  });

  test("no --color-* names are emitted to :root", () => {
    // `reference` keeps them out of the document entirely, so a host that also
    // uses Tailwind v4 keeps its own --color-background.
    assert.doesNotMatch(css, /--color-background:/);
    assert.doesNotMatch(css, /--color-foreground:/);
  });

  test("our rules are layered below Tailwind's utilities", () => {
    const base = css.indexOf("@layer base{");
    const utilities = css.indexOf("@layer utilities{");
    assert.ok(base !== -1, "our rules are unlayered, so they outrank every utility they sit next to");
    assert.ok(utilities !== -1, "no utilities layer");
    assert.ok(base < utilities, "@layer base must be declared before @layer utilities to lose to it");
  });

  test("every utility class in the EXPORTED sheet is scoped under .iv-scope", () => {
    // The exported sheet (mount="inline") shares the host's global class
    // namespace, so a bare `.hidden{display:none}` once collapsed a host app's
    // desktop layout. Scoping every class under `.iv-scope` -- which no host has
    // -- makes the sheet unable to reach any host element. Guard it: no bare
    // colliding utility may ship unscoped.
    // No bare host-colliding rule may ship (true even for a utility the widget
    // never uses -- there is simply no rule).
    for (const cls of ["hidden", "flex", "fixed", "block", "grid", "bg-background", "md\\:flex"]) {
      const bareHit = css.match(new RegExp(`(?<!iv-scope )\\.${cls}\\{`));
      assert.equal(bareHit, null, `.${cls.replace("\\", "")} must never ship as a bare, host-colliding rule`);
    }
    // And the ones the widget DOES use are present, scoped -- proving the
    // transform ran, not that the sheet is merely empty.
    assert.ok(css.includes(".iv-scope .hidden"), ".hidden should be scoped, not absent");
    assert.ok(css.includes(".iv-scope .flex"), ".flex should be scoped, not absent");
    // Definitions, not selectors, stay global: they don't collide, and scoping
    // them would hide the widget's own tokens.
    assert.doesNotMatch(css, /\.iv-scope\s+:root/);
    assert.doesNotMatch(css, /\.iv-scope\s+@property/);
  });

  test("the components' utilities were actually generated", () => {
    // Tailwind's automatic content detection keys off the build's root, not the
    // stylesheet's, and silently emitted almost nothing when those differed.
    // These are load-bearing classes from the bubble; if @source regresses,
    // the widget renders unstyled and this is why.
    for (const utility of [".flex-col", ".rounded-3xl", ".bg-foreground\\/4", ".animate-ping"]) {
      assert.ok(css.includes(utility), `${utility} was not generated; check @source in styles.css`);
    }
  });

  test("Tailwind's preflight is not shipped", () => {
    // Preflight is a global reset. In a widget dropped into someone else's
    // page it would silently restyle their entire document.
    assert.doesNotMatch(css, /\*,::before,::after\{box-sizing:border-box/);
  });
});
