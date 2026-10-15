import traverse from "@babel/traverse";
import path from "node:path";
import { parseFile, walk } from "../core/parse.js";
import { findDefinition, packageAliases } from "../core/resolveSymbol.js";

/**
 * Request body shapes, read from Zod schemas.
 *
 * The body cannot be recovered from the fetch call: it is a runtime object
 * built from component state. A validation schema is the only place the field
 * names and types are written down statically, which is why this exists at
 * all -- and why an app without one gets actions that can be addressed but
 * carry nothing, which is worse than useless.
 *
 * Scans the whole source tree rather than one `pages/` directory. Forms live
 * wherever an app puts them.
 */
/** Is this AST node a `z.object({...})` call? */
function isZodObject(node) {
  return (
    node?.type === "CallExpression" &&
    node.callee?.type === "MemberExpression" &&
    node.callee.object?.name === "z" &&
    node.callee.property?.name === "object" &&
    node.arguments?.[0]?.type === "ObjectExpression"
  );
}

/**
 * Strips wrappers (.optional(), .min(), .describe()...) to the base zod call,
 * reporting whether the field was optional on the way down.
 *
 * The subtlety, learned twice: a wrapper's name must never be read as the type.
 * `.optional()` on a referenced schema (`timeZoneSchema.optional()`) has no
 * z-type under it, so the descent stops and the caller keeps its default.
 */
function unwrap(node) {
  let required = true;
  while (node?.type === "CallExpression" && node.callee?.type === "MemberExpression") {
    const method = node.callee.property?.name;
    // .default(x) and .catch(x) both supply a value when the input is absent or
    // invalid, so the field is NOT required -- telling the model it must always
    // send a defaulted field is how "change one setting" overwrites the rest.
    if (method === "optional" || method === "nullish" || method === "default" || method === "catch") required = false;
    if (node.callee.object?.name === "z") return { base: node, required };
    if (node.callee.object?.type === "CallExpression") {
      node = node.callee.object;
      continue;
    }
    return { base: null, required }; // a referenced schema, or something unknown
  }
  return { base: null, required };
}

/**
 * A compact type for a zod node, recursing through arrays and objects.
 *
 * `z.array(z.array(z.object({start, end})))` becomes `Array<Array<{start, end}>>`
 * -- which is exactly the shape a flat "type: array" could not convey, and the
 * reason a model kept sending the wrong structure for cal.diy's weekday-indexed
 * schedule. Returns null for a plain scalar (the field's `type` already says
 * "string"), so only compound shapes are carried.
 *
 * Depth-capped, but the cap is only about the PROMPT. Past three levels the
 * rendered type is just "array"/"object" -- full depth would reproduce a huge
 * nested schema in the prompt we spent the dispatcher work shrinking, and three
 * levels covers everything a person would type by hand. That cap is a rendering
 * choice, not the limit of what we KNOW: it is deliberately separate from the
 * extraction below (dates) which runs to full depth, because knowing and showing
 * are two different jobs and one knob for both hid a real date-encoding bug
 * under the cap. When the render does truncate, `ctx.truncated` records it, so
 * the field can be flagged for review -- the model is being shown a partial
 * shape and will guess the rest.
 */
function shapeOf(node, depth = 0, ctx = { truncated: false }) {
  const { base } = unwrap(node);
  if (!base || base.callee?.object?.name !== "z") return null; // referenced/unknown
  const method = base.callee.property?.name;

  if (method === "array") {
    if (depth >= 3) {
      ctx.truncated = true;
      return "array";
    }
    const inner = shapeOf(base.arguments[0], depth + 1, ctx);
    return `Array<${inner ?? scalarName(base.arguments[0]) ?? "any"}>`;
  }
  if (method === "object") {
    if (depth >= 3) {
      ctx.truncated = true;
      return "object";
    }
    // Recurse into COMPOUND fields so a nested shape is shown, but leave a
    // scalar field as its bare name -- `{ start, end }` stays terse, while
    // `{ user: { name, email } }` gains the level it needs. Recursing is also
    // what lets a deep object chain reach the cap and flag itself truncated;
    // rendering names only would hide the depth without ever tripping it.
    const parts = (base.arguments[0]?.properties ?? [])
      .map((p) => {
        const key = p.key?.name ?? p.key?.value;
        if (key == null) return null;
        const inner = shapeOf(p.value, depth + 1, ctx); // null for a scalar
        return inner ? `${key}: ${inner}` : key;
      })
      .filter(Boolean);
    return parts.length ? `{ ${parts.join(", ")} }` : "object";
  }
  return null; // a scalar; `type` already carries it
}

/** The scalar type name of a node, for the leaf of an array. */
function scalarName(node) {
  const { base } = unwrap(node);
  return base?.callee?.object?.name === "z" ? base.callee.property?.name : null;
}

/** The wrapper methods on a node, outermost first: `z.array(x).min(7)` -> ["min"]. */
function wrapperMethods(node) {
  const methods = [];
  while (node?.type === "CallExpression" && node.callee?.type === "MemberExpression") {
    if (node.callee.object?.name === "z") break; // reached the base z.X()
    if (node.callee.property?.name) methods.push(node.callee.property.name);
    if (node.callee.object?.type === "CallExpression") {
      node = node.callee.object;
      continue;
    }
    break;
  }
  return methods;
}

/**
 * A field name that makes a list element self-describing. An array of objects
 * that each carry one of these is addressed by identity; an array of objects
 * that carry none is addressed by POSITION, and position is a convention we
 * cannot read.
 */
const IDENTIFYING = new Set([
  "id", "day", "weekday", "dayofweek", "date", "datetime", "type", "kind",
  "name", "key", "slug", "label", "index", "order", "uid", "code", "value",
]);

/**
 * Whether a field carries an unstated convention -- case (2), the weekday grid.
 *
 * The tell is meaning that rides on POSITION or an integer code, named by
 * nothing: a nested array (the index is a coordinate), an array of objects with
 * no identifying field (order or length does the work), or a fixed-length list
 * of bare values (the slots are enumerated). cal.diy's
 * `schedule: Array<Array<{start, end}>>` trips the first. Returns a human reason
 * or null. Tuned for recall: a false positive costs one glance by a reviewer, a
 * miss is a silent runtime failure.
 */
function opacity(node) {
  const { base } = unwrap(node);
  if (base?.callee?.object?.name !== "z" || base.callee.property?.name !== "array") return null;

  const inner = unwrap(base.arguments?.[0]).base;
  const innerMethod = inner?.callee?.object?.name === "z" ? inner.callee.property?.name : null;

  if (innerMethod === "array") return "nested array -- an index carries meaning that nothing names";
  if (innerMethod === "object") {
    const keys = (inner.arguments?.[0]?.properties ?? [])
      .map((p) => String(p.key?.name ?? p.key?.value ?? "").toLowerCase())
      .filter(Boolean);
    if (keys.length && !keys.some((k) => IDENTIFYING.has(k))) {
      return "array of objects with no identifying field -- order carries meaning";
    }
  }
  const scalarInner = innerMethod && !["array", "object"].includes(innerMethod);
  if (scalarInner && wrapperMethods(node).includes("length")) {
    return "fixed-length list of bare values -- the positions carry meaning";
  }
  return null;
}

/**
 * What, if anything, a human or LLM should look at before this field is trusted
 * on the API path. Build-time metadata, kept OFF the prompt (expand strips it):
 * a triage note that says "this might be knowable with a bit of checking", never
 * the model's confusion made into prompt text.
 *
 * Three kinds, most severe first. `unknown`: the shape itself is undetermined
 * (z.any/unknown/record) -- case (3), not resolvable by reading a schema that
 * says nothing. `opaque`: the shape is known but a convention rides on it --
 * case (2), resolvable by a reviewer. `truncated`: the render stopped at the
 * depth cap, so the model is shown a partial shape -- case (4), the weakest
 * signal, usually a deep peripheral field.
 */
function fieldReview({ type, node, truncated }) {
  if (type === "any" || type === "unknown") return { kind: "unknown", reason: `input type is z.${type}(); the shape is not determined` };
  if (type === "record") return { kind: "unknown", reason: "z.record() -- arbitrary keys, shape not determined" };
  const opaque = opacity(node);
  if (opaque) return { kind: "opaque", reason: opaque };
  if (truncated) return { kind: "truncated", reason: "shape truncated at render depth; deeper fields are not shown to the model" };
  return null;
}

/**
 * The key-paths under a field that end at a `z.date()`.
 *
 * A Date cannot survive the JSON the model speaks: tRPC's superjson transformer
 * needs it tagged, and the tag is built from these paths at request time (see
 * transports.js). Arrays are TRANSPARENT -- descending into `z.array(...)` adds
 * no path segment -- so cal.diy's `schedule: Array<Array<{start, end}>>` yields
 * `[["start"], ["end"]]`, the two dates buried under two positional arrays. A
 * field that is itself a bare `z.date()` yields `[[]]`: the empty path meaning
 * "the value here". Empty when the field holds no date, so only date-bearing
 * fields carry the annotation and the manifest stays lean.
 */
function datePaths(node, prefix = [], depth = 0) {
  const { base } = unwrap(node);
  if (!base || base.callee?.object?.name !== "z") return [];
  const method = base.callee.property?.name;
  if (method === "date") return [prefix];
  // Deliberately deep. This is EXTRACTION, not rendering: a path is a few bytes
  // whatever its depth, so the tight cap the prompt render uses buys nothing
  // here and would silently miss a date below it -- reintroducing the exact
  // "Expected date, received string" the superjson fix removed, now under the
  // cap where nothing looks. The high bound only guards a pathological schema.
  if (depth >= 8) return [];
  if (method === "array") return datePaths(base.arguments[0], prefix, depth + 1);
  if (method === "object") {
    const out = [];
    for (const p of base.arguments[0]?.properties ?? []) {
      const key = p.key?.name ?? p.key?.value;
      if (key != null) out.push(...datePaths(p.value, [...prefix, key], depth + 1));
    }
    return out;
  }
  return [];
}

function fieldsOf(objectExpression) {
  return objectExpression.properties.map((prop) => {
    // A SpreadElement (`z.object({ ...Base.shape, title: ... })`) has no `.key`;
    // reading `.key.name` off it threw, and because run() calls fieldsOf on
    // EVERY z.object in the tree, one spread anywhere wiped out all Zod body
    // extraction for the whole app. Skip what has no readable key -- the spread's
    // own fields go unread (an honest partial) rather than taking the rest down
    // with them. datePaths already guards its keys the same way.
    const name = prop.key?.name ?? prop.key?.value;
    if (name == null) return null;
    const { base, required } = unwrap(prop.value);
    let type = "string";
    let enumValues;
    if (base?.callee?.object?.name === "z") {
      type = base.callee.property?.name || type;
      if (type === "enum" && base.arguments[0]?.type === "ArrayExpression") {
        enumValues = base.arguments[0].elements.filter((e) => e?.type === "StringLiteral").map((e) => e.value);
      }
    }
    // The nested shape, only when it adds something a scalar type does not.
    // `ctx` catches a render truncation on the way, which becomes a review flag.
    const ctx = { truncated: false };
    const shape = shapeOf(prop.value, 0, ctx);
    // The paths to any dates inside, so the transport can tag them for superjson.
    const dates = datePaths(prop.value);
    // Whether a human/LLM should look before this field is trusted on the API.
    const review = fieldReview({ type, node: prop.value, truncated: ctx.truncated });
    return {
      name,
      required,
      type,
      ...(enumValues ? { enumValues } : {}),
      ...(shape && /[<{]/.test(shape) ? { shape } : {}),
      ...(dates.length ? { dates } : {}),
      ...(review ? { review } : {}),
    };
  }).filter(Boolean);
}

// Exported for tests; the enricher above is the only production caller.
export { fieldsOf, shapeOf, datePaths, opacity, fieldReview };

export const zodBodies = {
  name: "zod-bodies",
  role: "enricher",
  describe: "z.object({...}) schemas beside the form that submits them",

  run({ srcDir, root, actions = [] }) {
    if (!actions.length) return {};
    const visit = traverse.default ?? traverse;
    const enriched = [];

    // A producer that KNOWS which schema describes its input says so, and
    // that beats every heuristic below. tRPC procedures declare it outright
    // with `.input(ZDeleteInputSchema)`, so there is nothing left to guess.
    const named = actions.filter((a) => a._inputSchema && !a.bodyFields?.length);
    if (named.length) {
      const aliases = packageAliases(root ?? srcDir);

      for (const action of named) {
        // Follow the symbol from WHERE IT IS USED, across re-exports and
        // package boundaries, to the actual definition -- then read it as a
        // zod object. The resolver is schema-agnostic; only isZodObject and
        // fieldsOf below know it is Zod. `_inputSchemaFile` is where the
        // procedure declared `.input(...)`; without it there is no chain to
        // start from, so fall back to the name search underneath.
        if (action._inputSchemaFile) {
          const def = findDefinition(action._inputSchema, action._inputSchemaFile, aliases);
          if (isZodObject(def?.node)) {
            action.bodyFields = fieldsOf(def.node.arguments[0]);
            enriched.push(`${action.name} from ${action._inputSchema} (resolved across packages)`);
          }
        }
      }

      // Whatever the resolver could not place, try the older name-correlation:
      // scan for a local `const Name = z.object(...)` anywhere in the tree.
      const stillEmpty = named.filter((a) => !a.bodyFields?.length);
      if (stillEmpty.length) {
        const byName = new Map();
        for (const dir of [...new Set([srcDir, root, path.resolve(root ?? srcDir, "..", "..")])]) {
          for (const file of walk(dir, (n) => /\.tsx?$/.test(n))) {
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
                if (isZodObject(init)) byName.set(id.name, fieldsOf(init.arguments[0]));
              },
            });
          }
          if (byName.size) break;
        }
        for (const action of stillEmpty) {
          const fields = byName.get(action._inputSchema);
          if (!fields) continue;
          action.bodyFields = fields;
          enriched.push(`${action.name} from ${action._inputSchema}`);
        }
      }
    }

    for (const file of walk(srcDir, (n) => /\.(t|j)sx?$/.test(n))) {
      let ast;
      try {
        ast = parseFile(file);
      } catch {
        continue;
      }
      const schemas = [];
      const usedHooks = [];
      visit(ast, {
        VariableDeclarator(nodePath) {
          const init = nodePath.node.init;
          if (
            init?.type === "CallExpression" &&
            init.callee?.type === "MemberExpression" &&
            init.callee.object?.name === "z" &&
            init.callee.property?.name === "object" &&
            init.arguments[0]?.type === "ObjectExpression"
          ) {
            schemas.push(fieldsOf(init.arguments[0]));
          }
        },
        CallExpression(nodePath) {
          const callee = nodePath.node.callee;
          if (callee.type === "Identifier" && /^use[A-Z]/.test(callee.name) && !usedHooks.includes(callee.name)) {
            usedHooks.push(callee.name);
          }
        },
      });

      // One schema and one write hook in a file is the case that can be paired
      // without guessing. Two of either and the pairing would be a coin flip,
      // so it is left alone and reported rather than assigned wrongly.
      const writeHooks = usedHooks.filter((h) => actions.some((a) => a._hookName === h));
      if (schemas.length === 1 && writeHooks.length === 1) {
        const action = actions.find((a) => a._hookName === writeHooks[0]);
        if (action && !action.bodyFields.length) {
          action.bodyFields = schemas[0];
          enriched.push(action.name);
        }
      }
    }
    // Roll the FIELD flags up to their action -- the case-(2)/(4) marks that
    // fieldsOf set on individual zod fields (an opaque convention, a truncated
    // render). These belong to zod alone: only zod's reader looks deep enough
    // to raise them, and they can only be judged on a body zod itself filled.
    //
    // The operation-level "no readable body at all" flag deliberately does NOT
    // live here any more. Zod runs before the other body enrichers (TypeScript,
    // Valibot, Yup, ArkType), so a write it leaves empty is often filled a
    // moment later -- and a flag raised here would say "no input parser" over a
    // body another stage went on to type. That roll-up moved to the
    // `unresolved-bodies` enricher, which runs after all of them and so speaks
    // the truth. This `review` list stays in the manifest but never reaches the
    // model (expand strips it).
    const flagged = [];
    for (const action of actions) {
      const fieldFlags = (action.bodyFields ?? []).filter((f) => f.review).map((f) => ({ field: f.name, ...f.review }));
      if (fieldFlags.length) {
        action.review = [...(action.review ?? []), ...fieldFlags];
        flagged.push(action.name);
      }
    }

    const notes = enriched.length ? [`body fields from Zod: ${enriched.join(", ")}`] : [];
    if (flagged.length) notes.push(`fields flagged for review, kept off-prompt: ${flagged.length} action(s) (${flagged.slice(0, 8).join(", ")}${flagged.length > 8 ? ", ..." : ""})`);
    return { notes };
  },
};
