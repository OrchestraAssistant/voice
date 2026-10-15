import traverse from "@babel/traverse";
import { isDestructive } from "../../core/destructive.js";
import { parseFile, walk } from "../../core/parse.js";
import { findDefinition, packageAliases } from "../../core/resolveSymbol.js";

/**
 * GraphQL operations, read from the `gql` documents in the client source.
 *
 * A GraphQL client names its operations in tagged-template documents:
 *
 *   const CREATE_TASK = gql`
 *     mutation CreateTask($title: String!, $priority: Priority) {
 *       createTask(input: { title: $title, priority: $priority }) { id }
 *     }`;
 *
 * The operation header is everything needed: `mutation` vs `query` is read vs
 * write, the name becomes the tool, and the `$var: Type` list is the arguments
 * (a trailing `!` is required). The whole document is shipped so the widget's
 * graphql transport can POST it as `query`; the server does the rest.
 *
 * Only SELF-CONTAINED documents are emitted -- a `gql` template with no `${...}`
 * interpolation. A document that splices in a fragment cannot be reassembled
 * into a valid query statically without resolving every fragment reference, and
 * an operation whose document we cannot faithfully reproduce would be
 * addressable but uncallable -- the same trap that keeps Server Actions out.
 * Its header is still readable, but we do not pretend we can call it.
 * Subscriptions are skipped: they are not a request/response call.
 *
 * No AST of the GraphQL itself -- that would mean a graphql parser dependency.
 * The operation header is a small, regular grammar; the body we never inspect,
 * we only forward.
 */

/** A GraphQL variable type -> the manifest's small vocabulary. */
const SCALAR = { String: "string", ID: "string", Int: "number", Float: "number", Boolean: "boolean" };
function mapType(typeText) {
  const t = typeText.trim();
  if (/^\[.*\]/.test(t)) return "array"; // [String!], [ID!]! ...
  const base = t.replace(/[[\]!]/g, "").trim();
  return SCALAR[base] ?? "string"; // a custom scalar, enum or input object
}

/** Parse an operation header: `mutation Name($a: Int!, $b: T = 3) { ... }`. */
function parseOperation(doc) {
  const header = doc.match(/\b(query|mutation|subscription)\s+([A-Za-z_]\w*)\s*(\(([\s\S]*?)\))?/);
  if (!header) return null;
  const [, kind, name, , varsBlock] = header;
  if (kind === "subscription") return null;

  const variables = [];
  if (varsBlock) {
    for (const m of varsBlock.matchAll(/\$(\w+)\s*:\s*([^,)]+)/g)) {
      const rawType = m[2].split("=")[0].trim(); // drop a default value
      variables.push({ name: m[1], type: mapType(rawType), required: /!\s*$/.test(rawType) });
    }
  }
  return { kind, name, variables };
}

/** camelCase the operation name into a tool name: CreateTask -> createTask. */
const toolName = (name) => name.charAt(0).toLowerCase() + name.slice(1);

/** The literal text of one quasi (the cooked form, raw as a fallback). */
const quasiText = (q) => q?.value?.cooked ?? q?.value?.raw ?? "";

/** Is this AST node a `gql`/`graphql` tagged template? Returns its quasi. */
function gqlQuasi(node) {
  if (node?.type !== "TaggedTemplateExpression") return null;
  const tag = node.tag;
  const name = tag?.type === "Identifier" ? tag.name : tag?.property?.name;
  return name === "gql" || name === "graphql" ? node.quasi : null;
}

/**
 * The GraphQL endpoint, best-effort, from a client config -- `uri`/`url` on an
 * ApolloClient / HttpLink / urql createClient / GraphQLClient. Defaults to
 * `/graphql`, which is where the overwhelming majority of apps mount it.
 */
function findEndpoint(srcDir, visit) {
  for (const file of walk(srcDir, (n) => /\.(t|j)sx?$/.test(n))) {
    let ast;
    try {
      ast = parseFile(file);
    } catch {
      continue;
    }
    let imports = false;
    let uri = null;
    visit(ast, {
      ImportDeclaration(p) {
        if (/^(@apollo\/client|urql|@urql\/|graphql-request)/.test(p.node.source?.value ?? "")) imports = true;
      },
      ObjectProperty(p) {
        const key = p.node.key?.name ?? p.node.key?.value;
        if ((key === "uri" || key === "url") && p.node.value?.type === "StringLiteral" && !uri) {
          const v = p.node.value.value;
          if (/graphql/i.test(v) || v.startsWith("/")) uri = v;
        }
      },
    });
    if (imports && uri) return uri.replace(/^https?:\/\/[^/]+/, "") || "/graphql";
  }
  return "/graphql";
}

export const graphqlOperations = {
  name: "graphql-operations",
  role: "producer",
  describe: "gql`query/mutation Name($v: T) {...}` operation documents",

  run({ srcDir, root }) {
    const visit = traverse.default ?? traverse;
    const queries = [];
    const actions = [];
    const seen = new Set();
    let endpoint = null; // resolved lazily, only if an operation is found

    const aliases = packageAliases(root ?? srcDir);
    // Per-file gql inventory: the named documents (for fast local resolution)
    // and every document node (as consideration candidates). Cached so a file
    // referenced as a fragment source is parsed once.
    const fileCache = new Map();
    function docsOf(file) {
      if (fileCache.has(file)) return fileCache.get(file);
      let ast;
      try {
        ast = parseFile(file);
      } catch {
        const empty = { byName: new Map(), all: [] };
        fileCache.set(file, empty);
        return empty;
      }
      const byName = new Map();
      const all = [];
      visit(ast, {
        TaggedTemplateExpression(nodePath) {
          const quasi = gqlQuasi(nodePath.node);
          if (!quasi) return;
          all.push(quasi);
          const decl = nodePath.parent;
          if (decl?.type === "VariableDeclarator" && decl.id?.type === "Identifier") byName.set(decl.id.name, quasi);
        },
      });
      const info = { byName, all };
      fileCache.set(file, info);
      return info;
    }

    /** The gql document a name resolves to: local const first, then across files. */
    function resolveDoc(name, fromFile) {
      const local = docsOf(fromFile).byName.get(name);
      if (local) return { quasi: local, file: fromFile };
      // An imported fragment: follow the import/re-export chain to its definition
      // -- the same resolver the zod reader uses for cross-package schemas.
      const def = findDefinition(name, fromFile, aliases);
      const quasi = def && gqlQuasi(def.node);
      return quasi ? { quasi, file: def.file } : null;
    }

    /**
     * Reconstruct a document's runtime text, inlining every `${FRAGMENT}` the
     * way graphql-tag does -- resolving each interpolation to its gql document,
     * local OR imported, and recursing (a fragment defined in its own file
     * resolves its own imports). Returns null if any interpolation is not a
     * resolvable gql document, so an operation we cannot reproduce exactly is
     * never emitted as callable.
     */
    function reconstruct(quasiNode, fromFile, seenDocs = new Set()) {
      let text = quasiText(quasiNode.quasis[0]);
      for (let i = 0; i < quasiNode.expressions.length; i++) {
        const expr = quasiNode.expressions[i];
        if (expr.type !== "Identifier") return null;
        const key = `${fromFile}#${expr.name}`;
        if (seenDocs.has(key)) return null; // a fragment cycle
        const resolved = resolveDoc(expr.name, fromFile);
        if (!resolved) return null;
        const piece = reconstruct(resolved.quasi, resolved.file, new Set([...seenDocs, key]));
        if (piece == null) return null;
        text += piece + quasiText(quasiNode.quasis[i + 1]);
      }
      return text;
    }

    const consider = (quasiNode, fromFile) => {
      const doc = reconstruct(quasiNode, fromFile);
      if (!doc) return;
      const parsed = parseOperation(doc);
      if (!parsed) return;
      const name = toolName(parsed.name);
      if (seen.has(name)) return;
      seen.add(name);

      endpoint ??= findEndpoint(srcDir, visit);
      const base = {
        name,
        description: `Auto-detected GraphQL ${parsed.kind} ${parsed.name}`,
        method: parsed.kind === "query" ? "GET" : "POST", // read vs write intent; the wire is always POST
        endpoint,
        transport: "graphql",
        operationName: parsed.name,
        document: doc.trim(),
        // GraphQL passes every argument as `variables`; the transport reads them
        // off bodyFields for queries and mutations alike.
        params: [],
        bodyFields: parsed.variables,
      };
      if (parsed.kind === "query") {
        queries.push(base);
      } else {
        actions.push({ ...base, requiresConfirmation: isDestructive({ name: parsed.name }) });
      }
    };

    for (const file of walk(srcDir, (n) => /\.(t|j)sx?$/.test(n))) {
      for (const quasi of docsOf(file).all) consider(quasi, file);
    }
    return { queries, actions };
  },
};
