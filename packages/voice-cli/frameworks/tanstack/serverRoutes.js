import traverse from "@babel/traverse";
import { isDestructive } from "../../core/destructive.js";
import { parseFile, walk } from "../../core/parse.js";

/**
 * TanStack Start's API / server routes -- the callable HTTP surface of a Start
 * app (its page routing is already read by tanstack-router, and its
 * `createServerFn` server functions are RPC to a framework-internal id, the
 * Server-Actions case, so they are left alone rather than emitted uncallable).
 *
 * A server route declares its path as a string and its methods as an object:
 *
 *   export const Route = createAPIFileRoute('/api/users/$id')({
 *     GET: async ({ params }) => {...},
 *     POST: async ({ request }) => {...},
 *   });
 *   // or the newer spelling:
 *   export const ServerRoute = createServerFileRoute('/api/users').methods({ GET, POST });
 *
 * The path is the string argument (TanStack's `$id` param normalised to `{id}`),
 * the methods are the keys. Only the explicit-path forms are read; a
 * file-convention route with no path argument is left to a future fs reader
 * rather than guessed at. Gated on a @tanstack/*start import.
 */

const FACTORY = /^(createAPIFileRoute|createServerFileRoute)$/;
const WRITE_VERBS = { POST: "create", PUT: "update", PATCH: "update", DELETE: "delete" };

function usesStart(ast, visit) {
  let yes = false;
  visit(ast, {
    ImportDeclaration(p) {
      if (/^@tanstack\/(react-|solid-)?start/.test(p.node.source?.value ?? "")) yes = true;
    },
  });
  return yes;
}

/** `/api/users/$id` -> `/api/users/{id}`, collecting the params. */
function endpointOf(routePath) {
  const params = [];
  const endpoint = routePath
    .split("/")
    .map((seg) => {
      if (seg === "$") return "*";
      if (seg.startsWith("$")) {
        params.push(seg.slice(1));
        return `{${seg.slice(1)}}`;
      }
      return seg;
    })
    .join("/");
  return { endpoint, params };
}

function nameFrom(endpoint, method) {
  const camel = endpoint
    .split("/")
    .filter(Boolean)
    .map((s) => (s.startsWith("{") ? `by-${s.slice(1, -1)}` : s))
    .join("-")
    .replace(/[^a-zA-Z0-9-]/g, "")
    .replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    .replace(/-/g, "");
  const verb = WRITE_VERBS[method];
  return verb ? verb + camel.charAt(0).toUpperCase() + camel.slice(1) : camel || "root";
}

/** The method names keyed in the object passed to the factory or `.methods(...)`. */
function methodKeys(objExpr) {
  if (objExpr?.type !== "ObjectExpression") return [];
  return objExpr.properties
    .map((p) => (p.key?.name ?? p.key?.value ?? "").toUpperCase())
    .filter((m) => m === "GET" || WRITE_VERBS[m]);
}

export const tanstackServerRoutes = {
  name: "tanstack-server-routes",
  role: "producer",
  describe: "createAPIFileRoute('/path')({ GET, POST }) / createServerFileRoute TanStack Start API routes",

  run({ srcDir }) {
    const visit = traverse.default ?? traverse;
    const queries = [];
    const actions = [];
    const seen = new Set();

    for (const file of walk(srcDir, (n) => /\.(t|j)sx?$/.test(n))) {
      let ast;
      try {
        ast = parseFile(file);
      } catch {
        continue;
      }
      if (!usesStart(ast, visit)) continue;

      visit(ast, {
        CallExpression(nodePath) {
          const callee = nodePath.node.callee;
          // The factory call carries the path; the methods sit either in the
          // call that immediately follows it -- createAPIFileRoute('/x')({...}) --
          // or in a .methods({...}) member call on it.
          let factoryCall = null;
          let methodsObj = null;

          if (callee?.type === "CallExpression" && FACTORY.test(callee.callee?.name ?? "")) {
            factoryCall = callee;
            methodsObj = nodePath.node.arguments[0];
          } else if (
            callee?.type === "MemberExpression" &&
            callee.property?.name === "methods" &&
            callee.object?.type === "CallExpression" &&
            FACTORY.test(callee.object.callee?.name ?? "")
          ) {
            factoryCall = callee.object;
            methodsObj = nodePath.node.arguments[0];
          } else {
            return;
          }

          const pathArg = factoryCall.arguments[0];
          if (pathArg?.type !== "StringLiteral") return; // no explicit path -> left to a future fs reader
          const { endpoint, params } = endpointOf(pathArg.value);

          for (const method of methodKeys(methodsObj)) {
            const name = nameFrom(endpoint, method);
            if (seen.has(name)) continue;
            seen.add(name);
            const entry = {
              name,
              description: `Auto-detected ${method} server route at ${endpoint} (TanStack Start)`,
              method,
              endpoint,
              params: params.map((p) => ({ name: p, type: "string", required: true, source: "url" })),
            };
            if (method === "GET") queries.push(entry);
            else actions.push({ ...entry, requiresConfirmation: isDestructive({ method, name: entry.name }), bodyFields: [] });
          }
        },
      });
    }
    return { queries, actions };
  },
};
