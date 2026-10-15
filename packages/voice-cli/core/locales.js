import fs from "node:fs";
import path from "node:path";
import { walk } from "./parse.js";

/**
 * The English behind an internationalisation key.
 *
 * Source code holds `t("event_types_page_title")`; the sentence lives in a
 * locale file. Without this hop, every page in an internationalised app
 * describes itself as a key, which is worse than describing itself as nothing.
 *
 * cal.diy is the case in point: reading the page source yields
 * "event_types_page_title", and resolving it yields "Event types" plus
 * "Configure different events for people to book on your calendar." -- the
 * exact sentence the rendered page shows, recovered without running anything.
 */
const LOCALE_DIRS = [
  "locales/en", "public/locales/en", "public/static/locales/en",
  "src/locales/en", "messages", "i18n/locales/en", "lang/en",
];

/** Every key an app has English for, flattened. */
export function loadLocale(roots) {
  const table = new Map();
  const seen = new Set();

  const absorb = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    try {
      flatten(JSON.parse(fs.readFileSync(file, "utf-8")), "", table);
    } catch {
      // Not every JSON file is a locale, and a malformed one is not a reason
      // to abandon the rest.
    }
  };

  for (const root of roots) {
    for (const dir of LOCALE_DIRS) {
      const full = path.join(root, dir);
      if (!fs.existsSync(full)) continue;
      for (const file of walk(full, (n) => n.endsWith(".json"))) absorb(file);
    }
    // A monorepo hides its locales in a package: packages/i18n/locales/en/.
    if (!table.size) {
      for (const file of walk(root, (n) => n.endsWith(".json"))) {
        if (/(^|\/)(locales?|lang|messages|i18n)\/(en|en-US|en-GB)\//.test(file.replace(/\\/g, "/"))) absorb(file);
      }
    }
    if (table.size) break;
  }
  return table;
}

/** { a: { b: "x" } } -> "a.b" and "b", since apps key both ways. */
function flatten(value, prefix, table) {
  for (const [key, entry] of Object.entries(value ?? {})) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof entry === "string") {
      if (!table.has(full)) table.set(full, entry);
      if (!table.has(key)) table.set(key, entry);
    } else if (entry && typeof entry === "object") {
      flatten(entry, full, table);
    }
  }
}

/** The English for a key, or the key back if there is none. */
export const translate = (table, key) => table.get(key) ?? null;
