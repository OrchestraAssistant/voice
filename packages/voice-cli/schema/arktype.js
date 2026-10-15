import traverse from "@babel/traverse";
import { parseFile, walk } from "../core/parse.js";

/**
 * Request body shapes, read from ArkType schemas.
 *
 * ArkType writes types as STRINGS, which is its whole character and the reason
 * it needs its own reader: the field type is a little type-expression language,
 * and optionality rides on the KEY, not the value.
 *
 *   import { type } from "arktype";
 *   const CreateTask = type({
 *     name: "string",
 *     "count?": "number",           // trailing ? on the key = optional
 *     priority: "'low' | 'high'",   // a union of string literals = enum
 *     tags: "string[]",             // [] suffix = array
 *   });
 *
 * Read the key for optionality and the string value for the type. Gated on an
 * `arktype` import (tracking whatever local name `type` was bound to), so a
 * `type(...)` call from anywhere else is not mistaken for a schema. Associated
 * to actions by name, like the other schema enrichers.
 */

const SUFFIXES = /(Schema|Input|Payload|Body|Args|Params|Request|Dto|Data|Type)$/;
const candidateNames = (schemaName) => {
  const bare = schemaName.replace(SUFFIXES, "");
  return [schemaName, bare].map((n) => n.charAt(0).toLowerCase() + n.slice(1));
};

const SCALARS = { string: "string", number: "number", boolean: "boolean", bigint: "number", integer: "number" };

/** The local name(s) `type` is imported as from "arktype", if at all. */
function arktypeNames(ast, visit) {
  const names = new Set();
  visit(ast, {
    ImportDeclaration(nodePath) {
      if (nodePath.node.source?.value !== "arktype") return;
      for (const spec of nodePath.node.specifiers ?? []) {
        const imported = spec.imported?.name ?? (spec.type === "ImportDefaultSpecifier" ? "type" : null);
        if (imported === "type" || spec.type === "ImportDefaultSpecifier") names.add(spec.local.name);
      }
    },
  });
  return names;
}

/** A string type-expression -> the manifest's vocabulary. */
function readStringType(expr) {
  const s = expr.trim();
  const literals = [...s.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2]);
  if (literals.length) return { type: "enum", enumValues: literals };
  if (/\[\]\s*$/.test(s) || /^Array</.test(s)) return { type: "array" };
  // The base is the first bare word (ignore ` | null`, `>=1`, etc.).
  const base = s.match(/[a-zA-Z.]+/)?.[0]?.split(".")[0];
  return { type: SCALARS[base] ?? "string" };
}

function readField(valueNode) {
  if (valueNode?.type === "StringLiteral") return readStringType(valueNode.value);
  if (valueNode?.type === "ObjectExpression") return { type: "object" };
  return { type: "string" };
}

function fieldsOf(objectExpression) {
  return objectExpression.properties
    .filter((p) => p.key && (p.key.name || p.key.value))
    .map((p) => {
      const raw = String(p.key.name ?? p.key.value);
      const optional = raw.endsWith("?");
      return { name: optional ? raw.slice(0, -1) : raw, required: !optional, ...readField(p.value) };
    });
}

export const arktypeBodies = {
  name: "arktype-bodies",
  role: "enricher",
  describe: "type({...}) arktype schemas naming an action's input",

  run({ srcDir, actions = [] }) {
    const needsBody = actions.filter((a) => !a.bodyFields?.length);
    if (!needsBody.length) return {};

    const visit = traverse.default ?? traverse;
    const byName = new Map();
    for (const file of walk(srcDir, (n) => /\.(t|j)sx?$/.test(n))) {
      let ast;
      try {
        ast = parseFile(file);
      } catch {
        continue;
      }
      const locals = arktypeNames(ast, visit);
      if (!locals.size) continue;
      visit(ast, {
        VariableDeclarator(nodePath) {
          const { id, init } = nodePath.node;
          if (id.type !== "Identifier" || byName.has(id.name)) return;
          if (init?.type !== "CallExpression" || init.callee?.type !== "Identifier" || !locals.has(init.callee.name)) return;
          if (init.arguments[0]?.type === "ObjectExpression") byName.set(id.name, fieldsOf(init.arguments[0]));
        },
      });
    }
    if (!byName.size) return {};

    const byLength = [...byName.keys()].sort((a, b) => b.length - a.length);
    const filled = [];
    for (const action of needsBody) {
      if (action.bodyFields?.length) continue;
      const match = byLength.find((schema) => candidateNames(schema).includes(action.name));
      if (!match) continue;
      const urlParams = new Set((action.params ?? []).map((p) => p.name));
      action.bodyFields = byName.get(match).filter((f) => !urlParams.has(f.name));
      filled.push(`${action.name} from ${match}`);
    }
    return { notes: filled.length ? [`body fields from ArkType: ${filled.join(", ")}`] : [] };
  },
};

export { fieldsOf, readStringType };
