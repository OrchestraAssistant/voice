// Parsing helpers shared by every detector. Nothing app-specific lives here.

import { parse } from "@babel/parser";
import fs from "node:fs";
import path from "node:path";

export function parseFile(filePath) {
  return parse(fs.readFileSync(filePath, "utf-8"), {
    sourceType: "module",
    // TypeScript is not optional any more: the two frameworks worth reading
    // next are TS-first, and a parser that chokes on a type annotation sees
    // nothing at all rather than seeing less.
    plugins: ["jsx", "typescript"],
    errorRecovery: true,
  });
}

/** Every file under `dir` matching `test`, recursively. Skips the usual noise. */
export function walk(dir, test, out = []) {
  if (!fs.existsSync(dir)) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // An unreadable directory (permissions, a broken symlink) skips rather than
    // crashing the whole scan -- reachable when a search walks above the project
    // root into system directories like /etc/ssl/private.
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, test, out);
    else if (test(entry.name)) out.push(full);
  }
  return out;
}

/** The first directory of `candidates` that exists, or null. */
export const firstDir = (root, candidates) =>
  candidates.map((c) => path.join(root, c)).find((p) => fs.existsSync(p)) ?? null;

/**
 * The MONOREPO root above `from`, not just the nearest package.
 *
 * A workspace member (cal.diy's apps/web) holds its own package.json but its
 * components -- and the test-id templates in them, like `${weekday}-switch` in
 * packages/features -- live in SIBLING packages. Harvesting from the member
 * alone misses them, so a rendered `Sunday-switch` never finds its `*-switch`
 * shape. This walks up to the highest ancestor that looks like a repo root -- a
 * package.json declaring `workspaces`, a lockfile, or a .git -- so a grep from
 * there sees every package. Falls back to `from` for a plain single-package app,
 * where the member IS the whole tree.
 */
export function repoRoot(from) {
  let dir = from;
  let best = from;
  for (let i = 0; i < 15; i++) {
    const pkg = path.join(dir, "package.json");
    const isRoot =
      (fs.existsSync(pkg) && /["']workspaces["']/.test(safeRead(pkg))) ||
      fs.existsSync(path.join(dir, "yarn.lock")) ||
      fs.existsSync(path.join(dir, "pnpm-workspace.yaml")) ||
      fs.existsSync(path.join(dir, "package-lock.json")) ||
      fs.existsSync(path.join(dir, ".git"));
    if (isRoot) best = dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return best;
}

const safeRead = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

/** camelCase a hook name into a tool name: useCreateTask -> createTask. */
export const toolName = (hookName) => {
  const bare = hookName.replace(/^use/, "");
  return bare.charAt(0).toLowerCase() + bare.slice(1);
};

/**
 * Babel's traverse() needs a full Scope to walk a detached subtree, which we
 * do not have for nodes found by an outer traversal, so a plain recursive walk
 * is simpler and sufficient.
 */
export function walkCalls(node, calleeName, results = []) {
  if (!node || typeof node !== "object") return results;
  if (Array.isArray(node)) {
    node.forEach((n) => walkCalls(n, calleeName, results));
    return results;
  }
  if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === calleeName) {
    results.push(node);
  }
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "range") continue;
    if (node[key] && typeof node[key] === "object") walkCalls(node[key], calleeName, results);
  }
  return results;
}

export function objectProp(objExpr, propName) {
  if (!objExpr || objExpr.type !== "ObjectExpression") return null;
  const prop = objExpr.properties.find((p) => p.key && (p.key.name === propName || p.key.value === propName));
  return prop ? prop.value : null;
}

export const dedupeBy = (items, key = "name") => {
  const seen = new Set();
  return items.filter((i) => (seen.has(i[key]) ? false : seen.add(i[key])));
};
