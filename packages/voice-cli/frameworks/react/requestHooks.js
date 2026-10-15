import traverse from "@babel/traverse";
import { dedupeBy, objectProp, parseFile, toolName, walk, walkCalls } from "../../core/parse.js";

/**
 * Exported hooks that wrap a fetch helper: useQuery/useMutation plus a call to
 * a function whose job is to make the request.
 *
 * The helper is matched by shape rather than by the single name `request`,
 * since every codebase names it something different, and requiring one name
 * meant every app but ours extracted nothing.
 */
const HELPER_NAMES = ["request", "apiFetch", "api", "fetcher", "http", "client", "call"];

/** Module-level `const BASE = "/api"`, so a prefix inlines instead of becoming a param. */
function stringConstants(ast, visit) {
  const constants = {};
  visit(ast, {
    VariableDeclarator(nodePath) {
      if (nodePath.node.id.type === "Identifier" && nodePath.node.init?.type === "StringLiteral") {
        constants[nodePath.node.id.name] = nodePath.node.init.value;
      }
    },
  });
  return constants;
}

/**
 * Query-string parameter names hiding anywhere inside a node.
 *
 * A URL is commonly assembled as `${BASE}/tasks${search ? `?search=${search}` : ""}`.
 * The ternary is not an identifier, so the old code emitted it as `{param1}`
 * and marked it a REQUIRED url parameter -- producing the endpoint
 * "/api/tasks{param1}", which no request could ever satisfy. The name is right
 * there in the nested template's text.
 */
function queryParamNames(node, found = new Set()) {
  if (!node || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    node.forEach((n) => queryParamNames(n, found));
    return found;
  }
  if (node.type === "TemplateElement") {
    for (const m of (node.value?.raw ?? "").matchAll(/[?&]([A-Za-z_][\w-]*)=/g)) found.add(m[1]);
  }
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    if (node[key] && typeof node[key] === "object") queryParamNames(node[key], found);
  }
  return found;
}

/** A URL template plus the parameters it needs, by source. */
function urlFrom(node, constants) {
  if (!node) return null;
  if (node.type === "StringLiteral") return { endpoint: node.value, url: [], query: [] };
  if (node.type !== "TemplateLiteral") return null;

  let endpoint = "";
  const url = [];
  const query = new Set();
  node.quasis.forEach((quasi, i) => {
    endpoint += quasi.value.raw;
    const expr = node.expressions[i];
    if (!expr) return;
    if (expr.type === "Identifier" && constants[expr.name] !== undefined) {
      endpoint += constants[expr.name];
      return;
    }
    // Past a `?`, an interpolation is a QUERY param, not a required path segment.
    // `/api/tasks?status=${status}` used to emit `status` as a required url param
    // with the `?` baked into the path.
    const inQuery = endpoint.includes("?");
    if (expr.type === "Identifier") {
      endpoint += `{${expr.name}}`;
      inQuery ? query.add(expr.name) : url.push(expr.name);
      return;
    }
    // `${variables.id}` is at least as common as a bare identifier, because a
    // mutation receives one object. The property name IS the parameter name;
    // dropping it left the endpoint as "/api/tasks/" with a dangling slash and
    // no way to address anything.
    if (expr.type === "MemberExpression" && !expr.computed && expr.property?.type === "Identifier") {
      endpoint += `{${expr.property.name}}`;
      inQuery ? query.add(expr.property.name) : url.push(expr.property.name);
      return;
    }
    // Anything else is an expression we cannot evaluate. It contributes no
    // path text -- guessing produced a URL nothing could satisfy -- but the
    // query-string names inside it are readable and real.
    queryParamNames(expr).forEach((n) => query.add(n));
  });
  // A trailing slash left by an expression we could not read is not part of
  // the route, and would 404 on a strict server.
  return { endpoint: endpoint.length > 1 ? endpoint.replace(/\/$/, "") : endpoint, url, query: [...query] };
}

export const requestHooks = {
  name: "request-hooks",
  role: "producer",
  describe: "exported hooks calling useQuery/useMutation plus a fetch helper",

  run({ srcDir }) {
    const visit = traverse.default ?? traverse;
    const queries = [];
    const actions = [];

    for (const file of walk(srcDir, (n) => /\.(t|j)sx?$/.test(n))) {
      let ast;
      try {
        ast = parseFile(file);
      } catch {
        continue;
      }
      const constants = stringConstants(ast, visit);

      const consider = (hookName, body) => {
        const isQuery = walkCalls(body, "useQuery").length > 0;
        const isMutation = walkCalls(body, "useMutation").length > 0;
        if (!isQuery && !isMutation) return;

        const helper = HELPER_NAMES.map((n) => walkCalls(body, n)).find((calls) => calls.length > 0);
        if (!helper) return;
        const call = helper[0];
        const parsed = urlFrom(call.arguments[0], constants);
        if (!parsed?.endpoint) return;

        const method = (() => {
          const m = objectProp(call.arguments[1], "method");
          return m?.type === "StringLiteral" ? m.value : isMutation ? "POST" : "GET";
        })();

        const params = dedupeBy([
          ...parsed.url.map((p) => ({ name: p, type: "string", required: true, source: "url" })),
          // `query-string` is the source the widget actually acts on. The old
          // extractor emitted `hook-arg`, which nothing reads, so every filter
          // it found was silently dropped at request time.
          ...parsed.query.map((p) => ({ name: p, type: "string", required: false, source: "query-string" })),
        ]);

        const entry = {
          name: toolName(hookName),
          description: `Auto-detected ${isMutation ? "write action" : "read query"} from ${hookName}`,
          method,
          endpoint: parsed.endpoint,
          params,
        };
        if (isMutation) {
          actions.push({ ...entry, requiresConfirmation: /^(DELETE)$/.test(method), bodyFields: [], _hookName: hookName });
        } else {
          queries.push(entry);
        }
      };

      visit(ast, {
        ExportNamedDeclaration(nodePath) {
          const decl = nodePath.node.declaration;
          if (decl?.type === "FunctionDeclaration") {
            consider(decl.id.name, decl.body);
          }
          // `export const useTasks = () => {...}` is at least as common as the
          // function declaration, and reading only the latter skipped whole
          // codebases written in the other style.
          if (decl?.type === "VariableDeclaration") {
            for (const d of decl.declarations) {
              if (d.id.type !== "Identifier") continue;
              if (d.init?.type === "ArrowFunctionExpression" || d.init?.type === "FunctionExpression") {
                consider(d.id.name, d.init.body);
              }
            }
          }
        },
      });
    }
    return { queries, actions };
  },
};
