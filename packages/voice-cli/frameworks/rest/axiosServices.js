import traverse from "@babel/traverse";
import { isDestructive } from "../../core/destructive.js";
import { parseFile, walk } from "../../core/parse.js";

/**
 * REST operations, read from service CLASSES.
 *
 * A huge and common shape our other producers are blind to: a class of methods,
 * each wrapping an axios verb around a URL, over a backend that is not
 * JavaScript at all (Plane's is Django). There is no tRPC router, no Next route
 * handler, no react-query hook to read -- the operation lives in a method body:
 *
 *   export class IssueService extends APIService {
 *     async getIssues(workspaceSlug: string, projectId: string): Promise<IIssue[]> {
 *       return this.get(`/api/workspaces/${workspaceSlug}/projects/${projectId}/issues/`)
 *         .then((r) => r.data);
 *     }
 *     async createIssue(workspaceSlug: string, projectId: string, data: TIssuePayload): Promise<IIssue> {
 *       return this.post(`/api/workspaces/${workspaceSlug}/projects/${projectId}/issues/`, data)
 *         .then((r) => r.data);
 *     }
 *   }
 *
 * The method name is the operation, `this.<verb>` is the HTTP method, the
 * template literal is the URL (and its `${...}` holes are the url parameters),
 * and the body is the parameter passed as the second argument -- whose TS type
 * (`data: TIssuePayload`) the TypeScript enricher fills in, because the producer
 * records it as `_inputType`.
 *
 * The trigger is the CALL, not the base class: a method calling `this.get`,
 * `this.post`, `this.put`, `this.patch` or `this.delete` with a URL-shaped first
 * argument. Keying off `extends APIService` would fit Plane and no one else;
 * keying off the verb-on-a-URL fits the pattern wherever the base is named.
 */

const VERB_METHOD = { get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE" };

/** A first argument that looks like a URL, so `this.get(cacheKey)` is not a route. */
function looksLikeUrl(node) {
  if (node?.type === "StringLiteral") return node.value.includes("/");
  if (node?.type === "TemplateLiteral") return node.quasis.some((q) => (q.value?.raw ?? "").includes("/"));
  return false;
}

/** The URL text plus the params its `${...}` holes name, by source. */
function readUrl(node) {
  if (node?.type === "StringLiteral") return { endpoint: node.value, url: [] };
  if (node?.type !== "TemplateLiteral") return null;
  let endpoint = "";
  const url = [];
  node.quasis.forEach((quasi, i) => {
    endpoint += quasi.value.raw;
    const expr = node.expressions[i];
    if (!expr) return;
    if (expr.type === "Identifier") {
      endpoint += `{${expr.name}}`;
      url.push(expr.name);
    } else if (expr.type === "MemberExpression" && !expr.computed && expr.property?.type === "Identifier") {
      // `${data.id}` -- the property name is the parameter name.
      endpoint += `{${expr.property.name}}`;
      url.push(expr.property.name);
    }
    // Anything else contributes no path text; a URL we cannot fully read is
    // still worth its readable prefix.
  });
  return { endpoint: endpoint.replace(/\/{2,}/g, "/"), url };
}

/** axios query params: `this.get(url, { params: { cursor, per_page } })`. */
function queryParams(configNode) {
  if (configNode?.type !== "ObjectExpression") return [];
  const params = configNode.properties.find((p) => (p.key?.name ?? p.key?.value) === "params");
  if (params?.value?.type !== "ObjectExpression") return [];
  return params.value.properties.map((p) => p.key?.name ?? p.key?.value).filter(Boolean);
}

/**
 * The type NAME annotating a parameter, unwrapping the utility types that wrap
 * a body shape. `data: Partial<TIssue>` is TIssue with every field optional;
 * `data: TIssue` is TIssue as written. Returns { name, partial } or null.
 */
function typeRefName(param) {
  const ann = param?.typeAnnotation?.typeAnnotation;
  if (ann?.type !== "TSTypeReference") return null;
  const outer = ann.typeName?.name;
  if (["Partial", "Pick", "Omit", "Required", "Readonly"].includes(outer)) {
    // Babel 8 renamed TSTypeReference's `typeParameters` to `typeArguments`;
    // read whichever this parser build emits.
    const args = ann.typeArguments ?? ann.typeParameters;
    const inner = args?.params?.[0];
    if (inner?.type === "TSTypeReference") return { name: inner.typeName?.name, partial: outer === "Partial" };
    return null;
  }
  return outer ? { name: outer, partial: false } : null;
}

/** methodName + service base, for the collisions that repeat across services. */
const serviceBase = (className) => {
  const bare = className.replace(/Service$/, "");
  return bare.charAt(0).toLowerCase() + bare.slice(1);
};
const namespaced = (base, method) => base + method.charAt(0).toUpperCase() + method.slice(1);

/** Reads one `this.<verb>(...)` call inside a method into an operation. */
function operationFromCall(call, { methodName, params, className }) {
  const callee = call.callee;
  if (callee?.type !== "MemberExpression") return null;
  if (callee.object?.type !== "ThisExpression") return null;
  const verb = callee.property?.name;
  const method = VERB_METHOD[verb];
  if (!method) return null;
  if (!looksLikeUrl(call.arguments[0])) return null;

  const parsed = readUrl(call.arguments[0]);
  if (!parsed?.endpoint) return null;

  const write = method !== "GET";
  // The body argument: the second positional, when it is a parameter of the
  // method rather than an axios config object. `this.post(url, data)`.
  const bodyArg = write ? call.arguments[1] : null;
  const bodyParam =
    bodyArg?.type === "Identifier" ? params.find((p) => p.name === bodyArg.name) : null;
  const inputType = bodyParam ? typeRefName(bodyParam) : null;
  // The config object is whichever argument is an inline object (it carries
  // `params`/`headers`), regardless of position.
  const config = call.arguments.find((a) => a?.type === "ObjectExpression");
  const query = queryParams(config);

  const paramEntries = [
    ...parsed.url.map((p) => ({ name: p, type: "string", required: true, source: "url" })),
    ...query.map((p) => ({ name: p, type: "string", required: false, source: "query-string" })),
  ];

  const base = {
    name: methodName,
    description: `Auto-detected ${method} ${methodName} on ${parsed.endpoint} (${className})`,
    method,
    endpoint: parsed.endpoint,
    params: paramEntries,
    _service: className,
  };
  if (!write) return { kind: "query", entry: base };
  return {
    kind: "action",
    entry: {
      ...base,
      requiresConfirmation: isDestructive({ method, name: methodName }),
      bodyFields: [],
      ...(inputType?.name ? { _inputType: inputType.name, _inputPartial: inputType.partial } : {}),
    },
  };
}

export const axiosServices = {
  name: "axios-services",
  role: "producer",
  describe: "service classes whose methods call this.get/post/put/patch/delete(url, data)",

  run({ srcDir }) {
    const visit = traverse.default ?? traverse;
    const found = []; // { kind, entry }

    for (const file of walk(srcDir, (n) => /\.tsx?$/.test(n))) {
      let ast;
      try {
        ast = parseFile(file);
      } catch {
        continue;
      }
      visit(ast, {
        "ClassDeclaration|ClassExpression"(nodePath) {
          const className = nodePath.node.id?.name ?? "Service";
          for (const member of nodePath.node.body.body) {
            if (member.type !== "ClassMethod" || member.kind !== "method") continue;
            const methodName = member.key?.name ?? member.key?.value;
            if (!methodName || member.computed) continue;
            const params = member.params.filter((p) => p.type === "Identifier");
            // A method may make several requests; the first verb-on-a-URL call
            // is the operation the method name stands for.
            let call = null;
            (function findCall(node) {
              if (call || !node || typeof node !== "object") return;
              if (Array.isArray(node)) return node.forEach(findCall);
              if (
                node.type === "CallExpression" &&
                node.callee?.type === "MemberExpression" &&
                node.callee.object?.type === "ThisExpression" &&
                VERB_METHOD[node.callee.property?.name] &&
                looksLikeUrl(node.arguments[0])
              ) {
                call = node;
                return;
              }
              for (const key of Object.keys(node)) {
                if (key === "loc" || key === "start" || key === "end" || key === "range") continue;
                if (node[key] && typeof node[key] === "object") findCall(node[key]);
              }
            })(member.body);
            if (!call) continue;
            const op = operationFromCall(call, { methodName, params, className });
            if (op) found.push(op);
          }
        },
      });
    }

    // A method name like `list` or `create` repeats across services; the tRPC
    // producer hit the same wall and namespaces for the same reason. Rename ONLY
    // the ones that actually collide, so the common case keeps a clean name.
    const counts = new Map();
    for (const { entry } of found) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
    for (const { entry } of found) {
      if (counts.get(entry.name) > 1) entry.name = namespaced(serviceBase(entry._service), entry.name);
    }

    const queries = [];
    const actions = [];
    for (const { kind, entry } of found) {
      delete entry._service; // was only needed for namespacing
      (kind === "query" ? queries : actions).push(entry);
    }
    return { queries, actions };
  },
};
