/**
 * Test-id SHAPES harvested from source, and matching a measured id back to one.
 *
 * This is the static half of a two-part trick. A `data-testid` built from a
 * template -- `data-testid={`${weekday}-switch`}` -- reaches the running page
 * as `Sunday-switch` in English and `Domingo-switch` in Spanish. The probe can
 * only ever measure the rendered value, which is locale-bound and specific to
 * whatever data happened to be on screen. But the SHAPE, `*-switch`, is right
 * there in the source, and it is the marker that actually generalises.
 *
 * So: static analysis reads the shapes (it cannot know the values), the probe
 * measures a value (it cannot know the shape), and matching one to the other
 * recovers the thing neither could produce alone -- which is the manifest
 * pipeline's whole division of labour in miniature.
 *
 * A shape is the template with every `${...}` hole turned into `*`. Kept only
 * when it has real text around the hole: `${x}` alone is `*`, which matches
 * everything and signals nothing.
 */
import { execFileSync } from "node:child_process";
import traverse from "@babel/traverse";
import { parseFile } from "./parse.js";

const GREP_SCOPE = [
  "--include=*.tsx", "--include=*.jsx", "--include=*.ts", "--include=*.js",
  "--exclude-dir=node_modules", "--exclude-dir=.next", "--exclude-dir=dist",
];
const grepFiles = (pattern, flag, root) => {
  try {
    return execFileSync("grep", [flag, ...GREP_SCOPE, pattern, root],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 << 20 })
      .split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

/**
 * How widely the COMPONENT that emits `testId` is used -- the genericness the
 * element's own count hides.
 *
 * A shared affordance bakes its testId into a reusable component:
 * `export const PencilIcon = createIcon(Lucide, "pencil-icon")`. So the LITERAL
 * `pencil-icon` sits in exactly one file (the definition) and looks unique,
 * while the component renders on a dozen pages. Grepping the literal -- what the
 * readiness probe did -- is fooled every time; grepping the COMPONENT is not.
 *
 * The tell is the literal appearing in a single file that assigns it to a
 * PascalCase export. From there, count the files that use that name. Null when
 * the pattern does not hold -- a page-specific testId defined inline, or a shape
 * (handled elsewhere) -- so a genuinely local marker is never wrongly demoted.
 */
export function componentSpread(testId, root) {
  if (!testId || !root || testId.includes("*")) return null;
  const files = grepFiles(testId, "-rlF", root);
  if (files.length !== 1) return null; // not the one-definition shape of a shared component
  const owner = exportedOwner(files[0], testId);
  if (!owner || !/^[A-Z]/.test(owner)) return null; // a component is PascalCase; a config const is not
  return grepFiles(`\\b${owner}\\b`, "-rlE", root).filter((f) => f !== files[0]).length;
}

/** The binding name (a const/function/class) whose body holds `literal`, in `file`. */
function exportedOwner(file, literal) {
  let ast;
  try {
    ast = parseFile(file);
  } catch {
    return null;
  }
  const visit = traverse.default ?? traverse;
  let owner = null;
  visit(ast, {
    StringLiteral(path) {
      if (owner || path.node.value !== literal) return;
      const dec = path.findParent((p) => p.isVariableDeclarator());
      const fn = path.findParent((p) => p.isFunctionDeclaration() || p.isClassDeclaration());
      owner = dec?.node?.id?.name ?? fn?.node?.id?.name ?? null;
      if (owner) path.stop();
    },
  });
  return owner;
}

/** Every distinct test-id template in the source tree, as `*`-holed shapes. */
export function testIdShapes(root) {
  if (!root) return [];
  let out = "";
  try {
    out = execFileSync(
      "grep",
      ["-rhoE", "--include=*.tsx", "--include=*.jsx", "--include=*.ts", "--include=*.js",
       "--exclude-dir=node_modules", "--exclude-dir=.next", "--exclude-dir=dist",
       "data-testid=\\{`[^`]*`\\}", root],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 << 20 },
    );
  } catch {
    return []; // grep found nothing, or no grep; either way, no shapes
  }
  const shapes = new Set();
  for (const line of out.split("\n")) {
    const m = line.match(/`([^`]*)`/);
    if (!m || !m[1].includes("${")) continue;
    // Collapse every ${...} to a single *, then any run of *s to one.
    const shape = m[1].replace(/\$\{[^}]*\}/g, "*").replace(/\*+/g, "*");
    // Needs a real STEM, not just separators between holes. `${a}-${b}` becomes
    // `*-*`, whose only literal is a hyphen -- that matches nearly any
    // hyphenated id and would swallow `schedule-more`, which is not a template
    // instance at all. Require at least three alphanumeric characters of
    // literal text before a shape is allowed to stand in for a value.
    const stem = shape.replace(/\*/g, "").replace(/[^a-zA-Z0-9]/g, "");
    if (stem.length >= 3) shapes.add(shape);
  }
  return [...shapes];
}

/**
 * How many source files each shape's template appears in.
 *
 * A template-built id cannot be counted by its rendered value: `Sunday-switch`
 * is nowhere in the source, only `${weekday}-switch` is. So the readiness probe,
 * grepping the literal, scored it as "not found" and penalised it -- and lost it
 * to `pencil-icon`, a shared icon whose testId literal happens to sit in exactly
 * one file (its definition) though it renders everywhere. Counting the TEMPLATE
 * instead gives the shape a fair, real specificity: `*-switch` lives in one
 * file, and that one file is the availability editor.
 *
 * Same grep as testIdShapes, but keeping filenames, so each template can be
 * traced to the files that hold it.
 */
export function shapeFileCounts(root) {
  if (!root) return new Map();
  let out = "";
  try {
    out = execFileSync(
      "grep",
      ["-rHoE", "--include=*.tsx", "--include=*.jsx", "--include=*.ts", "--include=*.js",
       "--exclude-dir=node_modules", "--exclude-dir=.next", "--exclude-dir=dist",
       "data-testid=\\{`[^`]*`\\}", root],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 << 20 },
    );
  } catch {
    return new Map();
  }
  const files = new Map(); // shape -> Set<file>
  for (const line of out.split("\n")) {
    const at = line.indexOf(":data-testid=");
    if (at < 0) continue;
    const file = line.slice(0, at);
    const m = line.slice(at + 1).match(/`([^`]*)`/);
    if (!m || !m[1].includes("${")) continue;
    const shape = m[1].replace(/\$\{[^}]*\}/g, "*").replace(/\*+/g, "*");
    if (shape.replace(/\*/g, "").replace(/[^a-zA-Z0-9]/g, "").length < 3) continue;
    if (!files.has(shape)) files.set(shape, new Set());
    files.get(shape).add(file);
  }
  return new Map([...files].map(([shape, set]) => [shape, set.size]));
}

/** Does a rendered id fit a `*`-holed shape? `*` matches one-or-more chars. */
export function shapeMatches(shape, value) {
  const re = new RegExp("^" + shape.split("*").map(escapeRe).join(".+") + "$");
  return re.test(value);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The most specific shape a measured id belongs to, or the id unchanged.
 *
 * "Most specific" = the shape with the most literal (non-`*`) characters, so
 * `*-switch` is preferred over a hypothetical `*` and a longer stem wins over
 * a shorter one. A tie or no match returns the literal: a value that fits no
 * template was not built from one, and its own text is the right marker.
 */
export function generalize(value, shapes) {
  const fits = shapes
    .filter((s) => shapeMatches(s, value) && s !== value)
    .sort((a, b) => b.replace(/\*/g, "").length - a.replace(/\*/g, "").length);
  return fits[0] ?? value;
}
