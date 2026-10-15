import traverse from "@babel/traverse";
import { parseFile } from "../core/parse.js";
import { loadLocale, translate } from "../core/locales.js";

/**
 * What a page says it is, read from its source.
 *
 * The most useful description of a page is usually written down somewhere in
 * it, and probing can only recover it from pages that render on the server --
 * which on a real app is a minority. Cal.diy serves a shell for 61 of its 81
 * routes, so probing learned nothing about any of them. The source says it
 * either way.
 *
 * Framework-agnostic by looking for three shapes rather than one framework's
 * API:
 *
 *   export const metadata = { title, description }        Next.js
 *   generateMetadata(t => t("key"), t => t("subtitle"))   any wrapper
 *   <h1>Event types</h1>, <PageHeader title=... />        anything at all
 *
 * All three reduce to "string literals in title-ish positions", which is a
 * question you can ask of a component tree without knowing what framework
 * built it.
 */

/** Property names that hold a page's own name or explanation. */
const TITLE_KEYS = /^(title|heading|pageTitle|name|label)$/;
const SUBTITLE_KEYS = /^(description|subtitle|subheading|summary|pageSubtitle)$/;
/** Calls that wrap a translated string: t("key"), i18n.t("key"). */
const TRANSLATORS = /^(t|__|translate|i18n|intl)$/;

export const pageMetadata = {
  name: "page-metadata",
  role: "enricher",
  describe: "what each page declares about itself: metadata, headings, title props",

  run({ srcDir, root, routes = [] }) {
    const described = routes.filter((r) => r._file && !r.description);
    if (!described.length) return {};

    const visit = traverse.default ?? traverse;
    const locale = loadLocale([srcDir, root, `${root}/..`, `${root}/../..`]);
    const filled = [];

    for (const route of described) {
      let ast;
      try {
        ast = parseFile(route._file);
      } catch {
        continue;
      }

      const titles = [];
      const subtitles = [];

      visit(ast, {
        // export const metadata = { title: "...", description: "..." }
        ObjectProperty(nodePath) {
          const key = nodePath.node.key?.name ?? nodePath.node.key?.value;
          if (!key) return;
          const text = literalOrKey(nodePath.node.value);
          if (!text) return;
          if (TITLE_KEYS.test(key)) titles.push(text);
          if (SUBTITLE_KEYS.test(key)) subtitles.push(text);
        },
        // <PageHeader title="Event types" subtitle="..." />
        JSXAttribute(nodePath) {
          const key = nodePath.node.name?.name;
          if (!key) return;
          const value = nodePath.node.value;
          const text = literalOrKey(value?.type === "JSXExpressionContainer" ? value.expression : value);
          if (!text) return;
          if (TITLE_KEYS.test(key)) titles.push(text);
          if (SUBTITLE_KEYS.test(key)) subtitles.push(text);
        },
        // <h1>Event types</h1>
        JSXElement(nodePath) {
          if (nodePath.node.openingElement.name?.name !== "h1") return;
          const text = nodePath.node.children
            .map((child) => (child.type === "JSXText" ? child.value.trim() : literalOrKey(child.expression)))
            .filter(Boolean)
            .join(" ");
          if (text) titles.push(text);
        },
        // _generateMetadata(t => t("event_types_page_title"), t => t("..._subtitle"))
        // Positional: the first is the title, the second the explanation. That
        // is a convention rather than an API, and it is the one every wrapper
        // of this shape uses.
        CallExpression(nodePath) {
          if (!/generateMetadata|pageMetadata|buildMetadata/i.test(calleeName(nodePath.node.callee) ?? "")) return;
          const found = nodePath.node.arguments.map(translatedKey).filter(Boolean);
          if (found[0]) titles.push(found[0]);
          if (found[1]) subtitles.push(found[1]);
        },
      });

      const title = resolve(locale, titles);
      const subtitle = resolve(locale, subtitles);
      const parts = [title, subtitle].filter(Boolean);
      if (!parts.length) continue;
      route.description = parts.map((p) => p.replace(/\.?$/, ".")).join(" ");
      filled.push(route.path);
    }

    return { notes: filled.length ? [`described ${filled.length} page(s) from source`] : [] };
  },
};

/** A string literal, or the key inside t("..."). */
function literalOrKey(node) {
  if (!node) return null;
  if (node.type === "StringLiteral") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0]?.value?.raw ?? null;
  return translatedKey(node);
}

/** The key from t("x"), including inside an arrow like `(t) => t("x")`. */
function translatedKey(node) {
  if (!node) return null;
  if (node.type === "ArrowFunctionExpression") return translatedKey(node.body);
  if (node.type !== "CallExpression") return null;
  const name = calleeName(node.callee);
  if (!name || !TRANSLATORS.test(name)) return null;
  const first = node.arguments[0];
  return first?.type === "StringLiteral" ? first.value : null;
}

const calleeName = (callee) =>
  callee?.type === "Identifier" ? callee.name : callee?.property?.name ?? callee?.object?.name ?? null;

/**
 * The first candidate that is real text.
 *
 * A key that has no English is skipped rather than used: describing a page as
 * "event_types_page_title" is worse than describing it as nothing, because it
 * looks like information.
 */
function resolve(locale, candidates) {
  for (const candidate of candidates) {
    const english = translate(locale, candidate);
    if (english) return english;
    // Not a key at all: plain prose with a space in it, or a capitalised word.
    if (/\s/.test(candidate) || /^[A-Z]/.test(candidate)) {
      if (!/^[a-z0-9_.]+$/.test(candidate)) return candidate;
    }
  }
  return null;
}
