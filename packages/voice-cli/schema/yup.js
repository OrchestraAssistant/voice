import traverse from "@babel/traverse";
import { parseFile, walk } from "../core/parse.js";

/**
 * Request body shapes, read from Yup schemas.
 *
 * Yup is the validation library of a great many older React forms (Formik ships
 * with it). Its shape is chained like Zod's, with one inversion that matters:
 * a field is OPTIONAL by default and `.required()` opts in, the reverse of Zod.
 * Getting that backwards would mark every field required and make the model
 * refuse to send a valid partial request, so it is read explicitly.
 *
 *   const CreateTaskSchema = yup.object({
 *     title: yup.string().required(),
 *     priority: yup.string().oneOf(["low", "high"]),
 *   });
 *
 * Also handles `object().shape({...})`, the older spelling. `.oneOf([...])` is
 * an enum. Associated to actions by name, like the TypeScript enricher.
 */

const SUFFIXES = /(Schema|Input|Payload|Body|Args|Params|Request|Dto|Data|Validation)$/;
const candidateNames = (schemaName) => {
  const bare = schemaName.replace(SUFFIXES, "");
  return [schemaName, bare].map((n) => n.charAt(0).toLowerCase() + n.slice(1));
};

const TYPE_OF = { string: "string", number: "number", boolean: "boolean", bool: "boolean", array: "array", object: "object", date: "string", mixed: "string" };

/** The object schema's field map from `object({...})` or `object().shape({...})`. */
function objectArg(node) {
  let cursor = node;
  // Walk the chain looking for the base `object(...)` and any `.shape({...})`.
  let shape = null;
  let sawObject = false;
  while (cursor?.type === "CallExpression") {
    const callee = cursor.callee;
    const name = callee?.type === "Identifier" ? callee.name : callee?.type === "MemberExpression" ? callee.property?.name : null;
    if (name === "object") {
      sawObject = true;
      if (cursor.arguments[0]?.type === "ObjectExpression" && !shape) shape = cursor.arguments[0];
    }
    if (name === "shape" && cursor.arguments[0]?.type === "ObjectExpression" && !shape) shape = cursor.arguments[0];
    cursor = callee?.type === "MemberExpression" ? callee.object : null;
  }
  return sawObject ? shape : null;
}

/** Read a field's chain: base type, whether `.required()`, any `.oneOf([...])`. */
function readField(node) {
  let required = false;
  let baseType = "string";
  let enumValues;
  let cursor = node;
  const methods = []; // outermost first
  while (cursor?.type === "CallExpression" && cursor.callee?.type === "MemberExpression") {
    const method = cursor.callee.property?.name;
    if (method) methods.push({ name: method, args: cursor.arguments });
    cursor = cursor.callee.object;
  }
  // What the chain bottoms out in decides where the base type name is:
  //   yup.string().required()  -> stops on the `yup` Identifier; the innermost
  //                               member call (`.string`) IS the base, not a wrapper.
  //   string().required()      -> stops on the bare `string()` call; that is the base.
  let baseName = null;
  if (cursor?.type === "CallExpression" && cursor.callee?.type === "Identifier") {
    baseName = cursor.callee.name; // bare `string()`
  } else if (cursor?.type === "Identifier" && methods.length) {
    baseName = methods.pop().name; // `yup.string()` -- pop the base off the wrappers
  } else if (cursor?.type === "MemberExpression") {
    baseName = cursor.property?.name;
  }
  if (baseName && TYPE_OF[baseName]) baseType = TYPE_OF[baseName];

  for (const m of methods) {
    if (m.name === "required") required = true;
    if (m.name === "oneOf") {
      const arr = m.args[0];
      if (arr?.type === "ArrayExpression") {
        const vals = arr.elements.filter((e) => e?.type === "StringLiteral").map((e) => e.value);
        if (vals.length) enumValues = vals;
      }
    }
  }
  return { type: enumValues ? "enum" : baseType, required, ...(enumValues ? { enumValues } : {}) };
}

function fieldsOf(objectExpression) {
  return objectExpression.properties
    .filter((p) => p.key && (p.key.name || p.key.value))
    .map((p) => ({ name: p.key.name ?? p.key.value, ...readField(p.value) }));
}

export const yupBodies = {
  name: "yup-bodies",
  role: "enricher",
  describe: "yup.object({...}) / object().shape({...}) schemas naming an action's input",

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
    return { notes: filled.length ? [`body fields from Yup: ${filled.join(", ")}`] : [] };
  },
};

export { fieldsOf, readField };
