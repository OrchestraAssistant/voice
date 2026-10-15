import traverse from "@babel/traverse";
import { parseFile, walk } from "../core/parse.js";

/**
 * Request body shapes, read from Valibot schemas.
 *
 * Valibot is Zod's smaller, tree-shakeable cousin, and an app that chose it has
 * the same thing Zod gives us: the field names and types written down statically
 * next to the form. The API differs -- optionality and validation are functions
 * that WRAP a base type rather than methods that chain off it:
 *
 *   const CreateTaskSchema = v.object({
 *     title: v.pipe(v.string(), v.minLength(1)),
 *     priority: v.optional(v.picklist(["low", "high"])),
 *   });
 *
 * `v.optional(x)` / `v.nullish(x)` make a field optional; `v.pipe(base, ...)`
 * validates a base; `v.picklist([...])` is an enum. Read through those to the
 * base type. Associated to actions by name, like the TypeScript enricher and
 * for the same reason: being wrong is visible (the API rejects a bad field),
 * so a name match is safe where a silent guess would not be.
 */

const SUFFIXES = /(Schema|Input|Payload|Body|Args|Params|Request|Dto|Data)$/;
const candidateNames = (schemaName) => {
  const bare = schemaName.replace(SUFFIXES, "");
  return [schemaName, bare].map((n) => n.charAt(0).toLowerCase() + n.slice(1));
};

const TYPE_OF = { string: "string", number: "number", boolean: "boolean", array: "array", object: "object", date: "string" };

/** Is this node an `object({...})` / `v.object({...})` call? Returns the object arg. */
function objectArg(node) {
  if (node?.type !== "CallExpression") return null;
  const callee = node.callee;
  const name = callee?.type === "Identifier" ? callee.name : callee?.type === "MemberExpression" ? callee.property?.name : null;
  if (name !== "object") return null;
  return node.arguments[0]?.type === "ObjectExpression" ? node.arguments[0] : null;
}

/** The valibot base-schema name of a node, seeing through optional/nullish/pipe. */
function readField(node) {
  let required = true;
  let cursor = node;
  // Unwrap the wrappers that carry meaning: optionality and the pipe.
  for (let hops = 0; hops < 8 && cursor?.type === "CallExpression"; hops++) {
    const callee = cursor.callee;
    const name = callee?.type === "Identifier" ? callee.name : callee?.type === "MemberExpression" ? callee.property?.name : null;
    if (name === "optional" || name === "nullish" || name === "nullable") {
      if (name !== "nullable") required = false;
      cursor = cursor.arguments[0];
      continue;
    }
    if (name === "pipe") {
      cursor = cursor.arguments[0]; // the base is the first item of the pipe
      continue;
    }
    // A base type.
    if (name === "picklist" || name === "enum_" || name === "enum") {
      const arr = cursor.arguments[0];
      const values = arr?.type === "ArrayExpression"
        ? arr.elements.filter((e) => e?.type === "StringLiteral").map((e) => e.value)
        : undefined;
      return { type: "enum", required, ...(values?.length ? { enumValues: values } : {}) };
    }
    if (TYPE_OF[name]) return { type: TYPE_OF[name], required };
    break;
  }
  return { type: "string", required };
}

function fieldsOf(objectExpression) {
  return objectExpression.properties
    .filter((p) => p.key && (p.key.name || p.key.value))
    .map((p) => ({ name: p.key.name ?? p.key.value, ...readField(p.value) }));
}

export const valibotBodies = {
  name: "valibot-bodies",
  role: "enricher",
  describe: "v.object({...}) valibot schemas naming an action's input",

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
      visit(ast, {
        VariableDeclarator(nodePath) {
          const { id, init } = nodePath.node;
          if (id.type !== "Identifier" || byName.has(id.name)) return;
          const obj = objectArg(init);
          if (obj) byName.set(id.name, fieldsOf(obj));
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
    return { notes: filled.length ? [`body fields from Valibot: ${filled.join(", ")}`] : [] };
  },
};

export { fieldsOf, readField };
