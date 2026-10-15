import path from "node:path";
import { isDestructive } from "../../core/destructive.js";
import traverse from "@babel/traverse";
import { firstDir, parseFile, walk } from "../../core/parse.js";
import { isNextApp, NEXT_INFRASTRUCTURE } from "./detect.js";

/**
 * Next.js's own API layers, both of them.
 *
 * These are the easiest endpoints in any framework to read, and better than
 * what the hook detector can manage elsewhere: the filesystem gives the URL
 * and the exported function names give the method, with nothing to
 * pattern-match and nothing to guess. A React Router app makes us infer both
 * from a fetch call.
 *
 * What neither can give is the request BODY. A handler reads it at runtime
 * with `await request.json()`, so the shape lives in a type or a schema, not
 * in the handler. That is the gap the Zod detector and, later, TypeScript
 * types have to close.
 */

const WRITE_VERBS = { POST: "create", PUT: "update", PATCH: "update", DELETE: "delete" };

/** app/api/tasks/[id]/route.ts -> "/api/tasks/{id}" plus ["id"] */
function endpointFrom(relDir) {
  const params = [];
  const segments = [];
  for (const segment of relDir.split("/")) {
    if (!segment || segment === "." || (segment.startsWith("(") && segment.endsWith(")"))) continue;
    const dynamic = segment.match(/^\[\[?\.{0,3}(.+?)\]?\]$/);
    if (dynamic) {
      const name = dynamic[1].replace(/^\.\.\./, "");
      params.push(name);
      segments.push(`{${name}}`);
    } else {
      segments.push(segment);
    }
  }
  return { endpoint: "/" + segments.join("/"), params };
}

/** A tool name from a path: /api/tasks/{id} -> tasksById; with a verb for writes. */
function nameFrom(endpoint, method) {
  const parts = endpoint
    .split("/")
    .filter((s) => s && s !== "api")
    .map((s) => (s.startsWith("{") ? `by-${s.slice(1, -1)}` : s));
  const camel = parts
    .join("-")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    .replace(/-/g, "");
  // `/api` itself has no segment after the filter, so camel is empty. Fall back
  // to "root" (astro/tanstack already do) -- otherwise a GET /api handler got the
  // empty tool name "", and several root handlers collided on it.
  const base = camel || "root";
  const verb = WRITE_VERBS[method];
  return verb ? verb + base.charAt(0).toUpperCase() + base.slice(1) : base;
}

/** searchParams.get("status") -- the one query parameter a handler declares. */
function searchParams(ast, visit) {
  const names = new Set();
  visit(ast, {
    CallExpression(nodePath) {
      const callee = nodePath.node.callee;
      if (
        callee.type === "MemberExpression" &&
        callee.property?.name === "get" &&
        // Only a real `searchParams.get()` (bare, or `url.searchParams.get()`).
        // Matching /query/i too injected a phantom param from any `queryCache.get(...)`.
        /^searchParams$/.test(callee.object?.name ?? callee.object?.property?.name ?? "") &&
        nodePath.node.arguments[0]?.type === "StringLiteral"
      ) {
        names.add(nodePath.node.arguments[0].value);
      }
    },
  });
  return [...names];
}

function entryFor({ method, endpoint, urlParams, queryParams, source }) {
  const base = {
    name: nameFrom(endpoint, method),
    description: `Auto-detected ${method} handler at ${endpoint} (${source})`,
    method,
    endpoint,
    params: [
      ...urlParams.map((p) => ({ name: p, type: "string", required: true, source: "url" })),
      ...queryParams.map((p) => ({ name: p, type: "string", required: false, source: "query-string" })),
    ],
  };
  return method === "GET"
    ? { kind: "queries", entry: base }
    : { kind: "actions", entry: { ...base, requiresConfirmation: isDestructive({ method, name: base.name }), bodyFields: [] } };
}

export const nextRouteHandlers = {
  name: "next-route-handlers",
  role: "producer",
  excludes: NEXT_INFRASTRUCTURE,
  describe: "app/**/route.ts exporting GET/POST/PUT/PATCH/DELETE",
  applies: ({ root }) => isNextApp(root),

  run({ root }) {
    const appDir = firstDir(root, ["app", "src/app"]);
    if (!appDir) return {};
    const visit = traverse.default ?? traverse;
    const queries = [];
    const actions = [];

    for (const file of walk(appDir, (n) => /^route\.(t|j)s$/.test(n))) {
      let ast;
      try {
        ast = parseFile(file);
      } catch {
        continue;
      }
      const { endpoint, params: urlParams } = endpointFrom(path.relative(appDir, path.dirname(file)));
      const queryParams = searchParams(ast, visit);

      // Each exported function named for an HTTP verb IS that endpoint's
      // handler for that verb. No inference required.
      const methods = new Set();
      visit(ast, {
        ExportNamedDeclaration(nodePath) {
          const decl = nodePath.node.declaration;
          const names = [];
          if (decl?.type === "FunctionDeclaration" && decl.id) names.push(decl.id.name);
          if (decl?.type === "VariableDeclaration") {
            for (const d of decl.declarations) if (d.id.type === "Identifier") names.push(d.id.name);
          }
          for (const spec of nodePath.node.specifiers ?? []) names.push(spec.exported?.name);
          for (const n of names) if (n && (n === "GET" || WRITE_VERBS[n])) methods.add(n);
        },
      });

      for (const method of methods) {
        const { kind, entry } = entryFor({ method, endpoint, urlParams, queryParams, source: "route handler" });
        (kind === "queries" ? queries : actions).push(entry);
      }
    }
    return { queries, actions };
  },
};

export const nextPagesApi = {
  name: "next-pages-api",
  role: "producer",
  excludes: NEXT_INFRASTRUCTURE,
  describe: "pages/api/**/*.ts, with methods read from req.method branches",
  applies: ({ root }) => isNextApp(root),

  run({ root }) {
    const pagesDir = firstDir(root, ["pages", "src/pages"]);
    if (!pagesDir) return {};
    const apiDir = path.join(pagesDir, "api");
    const visit = traverse.default ?? traverse;
    const queries = [];
    const actions = [];

    for (const file of walk(apiDir, (n) => /\.(t|j)s$/.test(n))) {
      let ast;
      try {
        ast = parseFile(file);
      } catch {
        continue;
      }
      // The file IS the route here, not a directory: pages/api/tasks/[id].ts.
      const rel = path.relative(pagesDir, file).replace(/\.(t|j)s$/, "");
      const withoutIndex = rel.replace(/\/index$/, "");
      const { endpoint, params: urlParams } = endpointFrom(withoutIndex);

      // One default-exported handler serves every verb, and branches on
      // req.method inside. So the methods have to be read out of the
      // comparisons -- there are no per-verb exports to look at.
      const methods = new Set();
      visit(ast, {
        BinaryExpression(nodePath) {
          const { left, right, operator } = nodePath.node;
          if (!["===", "==", "!==", "!="].includes(operator)) return;
          for (const [a, b] of [[left, right], [right, left]]) {
            if (a.type === "MemberExpression" && a.property?.name === "method" && b.type === "StringLiteral") {
              const verb = b.value.toUpperCase();
              if (verb === "GET" || WRITE_VERBS[verb]) methods.add(verb);
            }
          }
        },
        SwitchCase(nodePath) {
          const test = nodePath.node.test;
          if (test?.type !== "StringLiteral") return;
          const verb = test.value.toUpperCase();
          if (verb === "GET" || WRITE_VERBS[verb]) methods.add(verb);
        },
      });
      // A handler with no branch at all answers everything; GET is the only
      // one safe to assume, since guessing a write would invent an operation.
      if (!methods.size) methods.add("GET");

      for (const method of methods) {
        const { kind, entry } = entryFor({
          method,
          endpoint,
          urlParams,
          queryParams: searchParams(ast, visit),
          source: "pages api",
        });
        (kind === "queries" ? queries : actions).push(entry);
      }
    }
    return { queries, actions };
  },
};
