import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CLI = join(dirname(new URL(import.meta.url).pathname), "..", "generate.js");

function app(files) {
  const root = mkdtempSync(join(tmpdir(), "page-meta-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  execFileSync(process.execPath, [CLI, root, join(root, ".voice")], { encoding: "utf8", stdio: "pipe" });
  return JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
}

const next = { "package.json": JSON.stringify({ dependencies: { next: "16" } }) };
const describedAs = (manifest, path) => manifest.routes.find((r) => r.path === path)?.description;

/**
 * What a page says it is, read from its source.
 *
 * Probing can only recover this from pages that render on the server, which on
 * a real app is a minority: cal.diy serves a shell for 61 of its 81 routes, so
 * probing learned nothing about any of them. Reading the source described 53.
 */
describe("reading what a page declares about itself", () => {
  test("a metadata export, which is the framework's own answer", () => {
    const m = app({
      ...next,
      "app/settings/page.tsx": `
        export const metadata = { title: "Settings", description: "Change your name, email and theme." };
        export default function P(){}`,
    });
    assert.equal(describedAs(m, "/settings"), "Settings. Change your name, email and theme.");
  });

  test("a heading and a title prop, which need no framework at all", () => {
    const m = app({
      ...next,
      "app/teams/page.tsx": `export default function P(){ return <div><h1>Your teams</h1></div>; }`,
      "app/billing/page.tsx": `export default function P(){ return <PageHeader title="Billing" subtitle="Invoices and payment methods." />; }`,
    });
    assert.equal(describedAs(m, "/teams"), "Your teams.");
    assert.equal(describedAs(m, "/billing"), "Billing. Invoices and payment methods.");
  });

  test("a translated key is resolved to English", () => {
    // Source holds t("event_types_page_title"); the sentence is in a locale
    // file. Without this hop every page in an internationalised app describes
    // itself as a key, which is worse than nothing because it looks like
    // information.
    const m = app({
      ...next,
      "locales/en/common.json": JSON.stringify({
        event_types_page_title: "Event types",
        event_types_page_subtitle: "Configure different events for people to book on your calendar.",
      }),
      "app/event-types/page.tsx": `
        export const generateMetadata = async () =>
          await _generateMetadata((t) => t("event_types_page_title"), (t) => t("event_types_page_subtitle"));
        export default function P(){}`,
    });
    assert.equal(
      describedAs(m, "/event-types"),
      "Event types. Configure different events for people to book on your calendar.",
    );
  });

  test("a key with no English is skipped, not printed raw", () => {
    const m = app({
      ...next,
      "locales/en/common.json": JSON.stringify({ something_else: "x" }),
      "app/mystery/page.tsx": `
        export const generateMetadata = async () => await _generateMetadata((t) => t("missing_key_title"));
        export default function P(){}`,
    });
    assert.equal(describedAs(m, "/mystery"), undefined);
  });

  test("nested locale files are flattened, since apps key both ways", () => {
    const m = app({
      ...next,
      "locales/en/common.json": JSON.stringify({ pages: { billing: { title: "Billing and plans" } } }),
      "app/billing/page.tsx": `
        export const metadata = { title: "pages.billing.title" };
        export default function P(){}`,
    });
    assert.equal(describedAs(m, "/billing"), "Billing and plans.");
  });

  test("a page that declares nothing is left alone", () => {
    // Inventing something would be worse than saying nothing.
    const m = app({ ...next, "app/quiet/page.tsx": "export default function P(){ return <div/>; }" });
    assert.equal(describedAs(m, "/quiet"), undefined);
  });

  test("the file a route came from never reaches the manifest", () => {
    // It is carried between detectors so an enricher can read the page. A
    // path from someone else's machine in the model's prompt would be a leak
    // and a waste of tokens.
    const m = app({ ...next, "app/x/page.tsx": `export const metadata = { title: "Ex" };\nexport default function P(){}` });
    assert.equal(JSON.stringify(m).includes("_file"), false);
    assert.equal(JSON.stringify(m).includes(tmpdir()), false);
  });
});
