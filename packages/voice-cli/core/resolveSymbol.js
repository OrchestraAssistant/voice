/**
 * Where an exported symbol is actually DEFINED, following re-exports across
 * packages.
 *
 * A schema is often not written where it is used. cal.diy's
 * `availabilityScheduleUpdate` says `.input(ZUpdateInputSchema)`, but that name
 * is `export { ZUpdateInputSchema } from "@calcom/features/.../ScheduleService"`
 * -- a re-export, to a z.object in a DIFFERENT package. Searching for a local
 * `const ZUpdateInputSchema = z.object(...)` finds nothing, so the action gets
 * no body fields and the model has to guess (it guessed 18 times and failed).
 *
 * This is deliberately schema-AGNOSTIC. It answers "given this symbol name and
 * the file that references it, what AST node is its value" and follows the
 * import / re-export chain to get there. What the node MEANS -- a Zod object, a
 * Yup schema, a TypeScript interface -- is the caller's business. So the same
 * resolver serves a zod reader, a yup reader, or a plain-type reader; only the
 * interpreter at the end differs.
 *
 * Module resolution handles relative paths and workspace package aliases
 * (`@calcom/features` -> `packages/features`), which is what makes it cross
 * PACKAGE and not just cross file.
 */
import fs from "node:fs";
import path from "node:path";

import { parseFile } from "./parse.js";

/**
 * Map workspace package names to their directories: `@calcom/features` ->
 * `/abs/packages/features`. Read from each package's own package.json `name`,
 * which is the authority an import actually resolves against.
 */
export function packageAliases(root) {
  const aliases = new Map();
  // Walk up to the monorepo root: the nearest ancestor with a `packages/` dir.
  let dir = root;
  let mono = null;
  for (let i = 0; i < 8 && dir; i++) {
    if (fs.existsSync(path.join(dir, "packages"))) mono = dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!mono) return aliases;

  for (const container of ["packages", "apps"]) {
    const base = path.join(mono, container);
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base)) {
      const pkgJson = path.join(base, name, "package.json");
      try {
        const { name: pkgName } = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
        if (pkgName) aliases.set(pkgName, path.join(base, name));
      } catch {
        // not a package
      }
    }
  }
  return aliases;
}

const EXTS = [".ts", ".tsx", ".js", ".jsx"];

/** An import specifier to a real file on disk, or null. */
export function resolveSpecifier(spec, fromFile, aliases) {
  let baseNoExt = null;

  if (spec.startsWith(".")) {
    baseNoExt = path.resolve(path.dirname(fromFile), spec);
  } else {
    // Longest matching package alias, so `@calcom/features/x` beats `@calcom`.
    let best = null;
    for (const [name, dirPath] of aliases) {
      if ((spec === name || spec.startsWith(name + "/")) && (!best || name.length > best.name.length)) {
        best = { name, dirPath };
      }
    }
    if (!best) return null;
    const rest = spec.slice(best.name.length).replace(/^\//, "");
    baseNoExt = rest ? path.join(best.dirPath, rest) : path.join(best.dirPath, "index");
  }

  for (const ext of EXTS) {
    if (fs.existsSync(baseNoExt + ext)) return baseNoExt + ext;
  }
  for (const ext of EXTS) {
    const asIndex = path.join(baseNoExt, "index" + ext);
    if (fs.existsSync(asIndex)) return asIndex;
  }
  return null;
}

/**
 * The value node an exported `name` resolves to, starting from `startFile` and
 * following imports and re-exports. Returns { file, node } or null.
 *
 * `node` is the initializer of the definition -- for `export const X = z.object(
 * {...})` it is the `z.object(...)` CallExpression. The caller decides whether
 * that is a schema it understands.
 */
export function findDefinition(name, startFile, aliases, seen = new Set()) {
  const stamp = `${startFile}#${name}`;
  if (seen.has(stamp) || !startFile || !fs.existsSync(startFile)) return null;
  seen.add(stamp);

  let ast;
  try {
    ast = parseFile(startFile);
  } catch {
    return null;
  }

  let localInit = null;
  let hop = null; // { spec, orig } to follow when there is no local definition
  const stars = []; // `export * from "spec"` barrels, followed only as a fallback

  for (const node of ast.program.body) {
    // export const NAME = ...   /   const NAME = ...
    const decl = node.type === "ExportNamedDeclaration" && node.declaration ? node.declaration : node;
    if (decl?.type === "VariableDeclaration") {
      for (const d of decl.declarations) {
        if (d.id?.type === "Identifier" && d.id.name === name && d.init) localInit = d.init;
      }
    }
    // export { NAME } / export { orig as NAME } [from "spec"]
    // import { NAME } / import { orig as NAME } from "spec"
    if (
      (node.type === "ExportNamedDeclaration" || node.type === "ImportDeclaration") &&
      node.specifiers?.length
    ) {
      for (const spec of node.specifiers) {
        const exported = spec.exported?.name ?? spec.local?.name;
        const imported = spec.imported?.name ?? spec.local?.name;
        if (exported === name || (node.type === "ImportDeclaration" && spec.local?.name === name)) {
          if (node.source?.value) hop = { spec: node.source.value, orig: imported ?? name };
        }
      }
    }
    // export * from "spec" -- lists no specifiers, so the block above skipped it
    // entirely. Collect the barrels; they are followed only if nothing else hits.
    if (node.type === "ExportAllDeclaration" && node.source?.value) stars.push(node.source.value);
  }

  if (localInit) return { file: startFile, node: localInit };
  if (hop) {
    const next = resolveSpecifier(hop.spec, startFile, aliases);
    if (next) return findDefinition(hop.orig, next, aliases, seen);
  }
  // A name found neither locally nor via a named re-export may still come through
  // an `export * from "./x"` barrel. Follow each in turn; `seen` guards cycles.
  // Barrels dominate large monorepos, and skipping them returned null -- empty
  // bodyFields, and the model left to guess the shape.
  for (const spec of stars) {
    const next = resolveSpecifier(spec, startFile, aliases);
    const found = next && findDefinition(name, next, aliases, seen);
    if (found) return found;
  }
  return null;
}
