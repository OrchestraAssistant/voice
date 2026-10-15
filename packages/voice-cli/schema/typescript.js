import traverse from "@babel/traverse";
import { parseFile, repoRoot, walk } from "../core/parse.js";

/**
 * Request body shapes, read from TypeScript.
 *
 * The body cannot be recovered from the call that sends it -- it is a runtime
 * object built from state -- so it has to come from somewhere it is written
 * down. Zod was the first answer, and it is the wrong dependency: a validation
 * library is one way an app might describe its data, and only some apps use
 * one. A TYPE is how a TypeScript app describes its data by definition, and
 * a Zod schema exists in order to produce one.
 *
 * Reads type aliases and interfaces from source, then matches them to actions
 * by name. Deliberately not the full TypeScript compiler: that would mean a
 * heavyweight dependency, a tsconfig, and a program that has to resolve every
 * import in the app. Names carry most of the signal -- `UpdateTaskInput`
 * belongs to `updateTask` -- and being wrong here is visible rather than
 * silent, because a body field that does not exist gets rejected by the API.
 */

/** A TS type annotation reduced to what the manifest can express. */
function jsonType(node) {
  if (!node) return "string";
  switch (node.type) {
    case "TSStringKeyword": return "string";
    case "TSNumberKeyword": return "number";
    case "TSBooleanKeyword": return "boolean";
    case "TSArrayType": return "array";
    case "TSUnionType": {
      // A union of string literals is an enum, which is worth keeping: it
      // tells the model exactly which values are legal.
      const literals = node.types.filter((t) => t.type === "TSLiteralType" && t.literal?.type === "StringLiteral");
      const nonNullish = node.types.filter((t) => !["TSNullKeyword", "TSUndefinedKeyword"].includes(t.type));
      // An enum only when EVERY non-nullish member is a string literal. The old
      // `>= length - 1` tolerated one arbitrary non-literal, so `"a" | "b" |
      // boolean` became an enum of ["a","b"] and silently dropped boolean.
      if (literals.length && literals.length === nonNullish.length) return "enum";
      const first = nonNullish[0];
      return jsonType(first);
    }
    case "TSLiteralType": return typeof node.literal?.value === "boolean" ? "boolean" : "string";
    default: return "string";
  }
}

function enumValues(node) {
  if (node?.type !== "TSUnionType") return undefined;
  const values = node.types
    .filter((t) => t.type === "TSLiteralType" && t.literal?.type === "StringLiteral")
    .map((t) => t.literal.value);
  return values.length ? values : undefined;
}

function membersOf(typeNode) {
  // A type alias holds `members`; an interface body holds `body`, which IS the
  // array rather than a wrapper around one. Reading only the alias shape meant
  // every interface in the codebase was silently skipped.
  const members = typeNode?.members ?? (Array.isArray(typeNode?.body) ? typeNode.body : typeNode?.body?.body) ?? [];
  return members
    .filter((m) => m.type === "TSPropertySignature" && (m.key?.name || m.key?.value))
    .map((m) => {
      const annotation = m.typeAnnotation?.typeAnnotation;
      const type = jsonType(annotation);
      // Only when it is actually an enum: a mixed union like `"a" | "b" | boolean`
      // is typed "string", and must not also carry a closed set that omits boolean.
      const values = type === "enum" ? enumValues(annotation) : undefined;
      return {
        name: m.key.name ?? m.key.value,
        // `?:` is the whole optionality story in a type, and it is exact
        // rather than heuristic.
        required: !m.optional,
        type,
        ...(values ? { enumValues: values } : {}),
      };
    });
}

/** UpdateTaskInput / UpdateTaskPayload / UpdateTaskBody / UpdateTaskArgs -> updateTask */
const SUFFIXES = /(Input|Payload|Body|Args|Params|Request|Dto|Data)$/;
const candidateNames = (typeName) => {
  const bare = typeName.replace(SUFFIXES, "");
  return [typeName, bare].map((n) => n.charAt(0).toLowerCase() + n.slice(1));
};

/** Every type alias/interface under `dirs`, optionally only the names wanted. */
function collectTypes(dirs, visit, only = null) {
  const types = new Map();
  const want = (name) => !only || only.has(name);
  for (const dir of [...new Set(dirs.filter(Boolean))]) {
    for (const file of walk(dir, (n) => /\.tsx?$/.test(n))) {
      let ast;
      try {
        ast = parseFile(file);
      } catch {
        continue;
      }
      visit(ast, {
        TSTypeAliasDeclaration(nodePath) {
          const name = nodePath.node.id.name;
          if (types.has(name) || !want(name)) return;
          const fields = membersOf(nodePath.node.typeAnnotation);
          if (fields.length) types.set(name, fields);
        },
        TSInterfaceDeclaration(nodePath) {
          const name = nodePath.node.id.name;
          if (types.has(name) || !want(name)) return;
          const fields = membersOf(nodePath.node.body);
          if (fields.length) types.set(name, fields);
        },
      });
    }
  }
  return types;
}

export const tsTypes = {
  name: "typescript-types",
  role: "enricher",
  describe: "type aliases and interfaces naming an action's input",

  run({ srcDir, actions = [] }) {
    const needsBody = actions.filter((a) => !a.bodyFields?.length);
    if (!needsBody.length) return {};

    const visit = traverse.default ?? traverse;
    const types = collectTypes([srcDir], visit);

    const filled = [];
    /** URL params are already in `params`; a body must not repeat the id. */
    const fill = (action, typeName, map, partial) => {
      const urlParams = new Set((action.params ?? []).map((p) => p.name));
      let fields = map.get(typeName).filter((f) => !urlParams.has(f.name));
      // `Partial<T>` makes every field optional -- the whole point of a partial
      // update is that you send only what changes.
      if (partial) fields = fields.map((f) => ({ ...f, required: false }));
      action.bodyFields = fields;
      filled.push(`${action.name} from ${typeName}${partial ? " (Partial)" : ""}`);
    };

    // A producer that KNOWS which type is its input says so with `_inputType`
    // (axios-services reads `data: TIssuePayload` off the method signature), and
    // that beats name correlation. Try those first, and only for them widen the
    // search past srcDir -- a monorepo keeps shared types in a sibling package
    // (`@plane/types`), which the default srcDir walk never sees. The widening
    // is gated on an unresolved `_inputType`, so an app that sets none is
    // scanned exactly as before.
    const explicit = needsBody.filter((a) => a._inputType);
    for (const action of explicit) if (types.has(action._inputType)) fill(action, action._inputType, types, action._inputPartial);
    const unresolved = explicit.filter((a) => !a.bodyFields?.length);
    if (unresolved.length) {
      // Widen to the MONOREPO root, and no further. A shared type lives in a
      // sibling workspace package (`@plane/types`), which repoRoot() finds by
      // walking up to the workspace boundary -- never past it. The earlier,
      // naive `root/../..` walked OUTSIDE the repo into /tmp (and, from a repo
      // at the filesystem's edge, toward `/`): slow, and not the app's code.
      const top = repoRoot(srcDir);
      if (top !== srcDir) {
        const wide = collectTypes([top], visit, new Set(unresolved.map((a) => a._inputType)));
        for (const action of unresolved) if (wide.has(action._inputType)) fill(action, action._inputType, wide, action._inputPartial);
      }
    }

    // Everything without an explicit type falls back to name correlation over
    // the srcDir types, exactly as before. Longest name first, so
    // UpdateTaskInput wins over TaskInput for updateTask.
    if (types.size) {
      const byLength = [...types.keys()].sort((a, b) => b.length - a.length);
      for (const action of needsBody.filter((a) => !a._inputType && !a.bodyFields?.length)) {
        const match = byLength.find((typeName) => candidateNames(typeName).includes(action.name));
        if (match) fill(action, match, types, false);
      }
    }
    return { notes: filled.length ? [`body fields from TypeScript: ${filled.join(", ")}`] : [] };
  },
};
