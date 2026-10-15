import path from "node:path";
import { isDestructive } from "../../core/destructive.js";
import traverse from "@babel/traverse";
import { parseFile, walk } from "../../core/parse.js";
import { usesTrpc } from "./detect.js";

/**
 * tRPC procedures, which have no URLs in the source at all.
 *
 * tRPC is a typed remote-procedure layer: you declare procedures and group
 * them into routers, and the client calls them by path rather than by URL.
 * Types flow end to end because the client imports the router's TYPE. That is
 * exactly why hunting for URL strings found 209 call sites in cal.diy and
 * zero endpoints -- there is no URL in the client code to find.
 *
 * Read from the SERVER instead, where the shape is declarative:
 *
 *   export const availabilityRouter = router({
 *     list: authedProcedure.query(...),
 *     user: authedProcedure.input(ZUserInputSchema).query(...),
 *     schedule: scheduleRouter,
 *   });
 *
 * The key is the procedure name, `.query` versus `.mutation` says read or
 * write, `.input(X)` names the schema, and a value that is another router
 * nests. Everything needed is there.
 */

/** `export const xRouter = router({...})` -> the object literal, by name. */
function collectRouters(srcDir, visit) {
  const routers = new Map();
  for (const file of walk(srcDir, (n) => /\.tsx?$/.test(n))) {
    let ast;
    try {
      ast = parseFile(file);
    } catch {
      continue;
    }
    visit(ast, {
      VariableDeclarator(nodePath) {
        const { id, init } = nodePath.node;
        if (id.type !== "Identifier") return;
        if (init?.type !== "CallExpression") return;
        // Match `router({...})`, `t.router({...})` (a MemberExpression callee --
        // the most common style), and the `createTRPCRouter`/`createRouter`
        // factory names. Only the bare `router(` was matched before, so a stock
        // `t.router({...})` app yielded ZERO routers, and the empty result then
        // sent the search walking up into parent directories looking for them.
        const callee = init.callee;
        const isRouterCall =
          (callee?.type === "Identifier" && /^(router|createTRPCRouter|createRouter)$/.test(callee.name)) ||
          (callee?.type === "MemberExpression" && callee.property?.name === "router");
        if (!isRouterCall) return;
        if (init.arguments[0]?.type !== "ObjectExpression") return;
        routers.set(id.name, { node: init.arguments[0], file });
      },
    });
  }
  return routers;
}

/**
 * Where each router is served.
 *
 * Stock tRPC mounts one handler and addresses procedures by their full dotted
 * path. cal.diy does not: it splits into a dozen handlers by namespace to keep
 * serverless bundles small, so its real URLs look like
 * /api/trpc/availability/schedule.update. A detector assuming the standard
 * shape would emit URLs that 404 -- which is what my first probe of
 * /api/trpc/viewer.features.map did.
 *
 * So the mounts are read rather than assumed. The directory names the URL
 * segment and the import names the router.
 */
function collectMounts(root, visit) {
  const mounts = [];
  for (const base of ["pages/api/trpc", "src/pages/api/trpc", "app/api/trpc", "src/app/api/trpc"]) {
    const dir = path.join(root, base);
    for (const file of walk(dir, (n) => /^(\[.*\]|route)\.(t|j)sx?$/.test(n))) {
      let ast;
      try {
        ast = parseFile(file);
      } catch {
        continue;
      }
      // The segment between the trpc directory and the [trpc] file, if any.
      const rel = path.relative(dir, path.dirname(file)).split(path.sep).filter((s) => s && !s.startsWith("["));
      let routerName = null;
      visit(ast, {
        CallExpression(nodePath) {
          const callee = nodePath.node.callee;
          if (!/^(create\w*ApiHandler|fetchRequestHandler|createNextApiHandler)$/.test(callee?.name ?? "")) return;
          const arg = nodePath.node.arguments[0];
          if (arg?.type === "Identifier") routerName = arg.name;
          // fetchRequestHandler({ router: appRouter, ... })
          if (arg?.type === "ObjectExpression") {
            const prop = arg.properties.find((p) => p.key?.name === "router");
            if (prop?.value?.type === "Identifier") routerName = prop.value.name;
          }
        },
      });
      if (routerName) mounts.push({ routerName, prefix: ["/api/trpc", ...rel].join("/"), namespace: rel.join("-") });
    }
  }
  return mounts;
}

/** The procedure chain: authedProcedure.input(Z).query(fn) */
function readProcedure(node) {
  let kind = null;
  let inputSchema = null;
  let current = node;
  while (current?.type === "CallExpression") {
    const callee = current.callee;
    if (callee?.type !== "MemberExpression") break;
    const method = callee.property?.name;
    if ((method === "query" || method === "mutation") && !kind) kind = method;
    if (method === "input" && !inputSchema) {
      const arg = current.arguments[0];
      if (arg?.type === "Identifier") inputSchema = arg.name;
    }
    current = callee.object;
  }
  return kind ? { kind, inputSchema } : null;
}

/** Walks a router object, following nested routers, collecting dotted paths. */
function walkRouter(entry, routers, prefix, seen, out) {
  const { node: objectExpression, file } = entry;
  for (const prop of objectExpression.properties) {
    const name = prop.key?.name ?? prop.key?.value;
    if (!name || !prop.value) continue;
    const dotted = prefix ? `${prefix}.${name}` : name;

    // `schedule: scheduleRouter` -- a nested namespace.
    if (prop.value.type === "Identifier" && routers.has(prop.value.name)) {
      if (seen.has(prop.value.name)) continue; // routers can reference each other
      seen.add(prop.value.name);
      walkRouter(routers.get(prop.value.name), routers, dotted, seen, out);
      continue;
    }
    if (prop.value.type === "CallExpression" && prop.value.callee?.name === "router") {
      if (prop.value.arguments[0]?.type === "ObjectExpression") {
        walkRouter({ node: prop.value.arguments[0], file }, routers, dotted, seen, out);
      }
      continue;
    }
    const procedure = readProcedure(prop.value);
    // The file the procedure was defined in, so a schema reader can start from
    // there and follow the import chain to a schema in another package.
    if (procedure) out.push({ path: dotted, file, ...procedure });
  }
}

/**
 * apiKeys + "create" -> apiKeysCreate.
 *
 * The namespace has to be in the name. Procedure names like `create`, `update`
 * and `delete` repeat across every router in a real app -- cal.diy has four of
 * each -- so a name built from the procedure path alone collides, and two
 * different endpoints end up as one tool.
 */
const toolName = (namespace, dotted) =>
  [namespace, ...dotted.split(".")]
    .filter(Boolean)
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("");

export const trpcRouters = {
  name: "trpc-routers",
  role: "producer",
  describe: "router({ name: procedure.input(X).query(...) }) definitions",
  applies: ({ root }) => usesTrpc(root),
  excludes: [
    { pattern: /^\/api\/trpc\/admin\//, why: "site-administration procedures" },
    { pattern: /^\/api\/trpc\/deploymentSetup\//, why: "deployment setup, run once by an operator" },
  ],

  run({ srcDir, root }) {
    const visit = traverse.default ?? traverse;
    // Routers live in the workspace, not necessarily under the app's srcDir:
    // cal.diy keeps every one of them in a sibling package.
    const searchRoots = [srcDir, root, path.resolve(root, "..", ".."), path.resolve(root, "..")];
    const routers = new Map();
    for (const dir of [...new Set(searchRoots)]) {
      for (const [name, entry] of collectRouters(dir, visit)) if (!routers.has(name)) routers.set(name, entry);
      if (routers.size) break;
    }
    if (!routers.size) return {};

    const mounts = collectMounts(root, visit);
    if (!mounts.length) return {};

    const queries = [];
    const actions = [];
    for (const { routerName, prefix, namespace } of mounts) {
      const rootObject = routers.get(routerName);
      if (!rootObject) continue;
      const procedures = [];
      walkRouter(rootObject, routers, "", new Set([routerName]), procedures);

      for (const proc of procedures) {
        const endpoint = `${prefix}/${proc.path}`;
        const entry = {
          name: toolName(namespace, proc.path),
          description: `Auto-detected tRPC ${proc.kind} ${proc.path}`,
          method: proc.kind === "query" ? "GET" : "POST",
          endpoint,
          // Not REST. Input is superjson-wrapped and travels in a query string
          // for a query and in the body for a mutation, so the widget needs to
          // know this is a procedure call rather than a plain fetch.
          transport: "trpc",
          params: [],
          // The producer says exactly which type describes its input, so the
          // schema readers can stop guessing from name correlation.
          ...(proc.inputSchema ? { _inputSchema: proc.inputSchema, _inputSchemaFile: proc.file } : {}),
        };
        if (proc.kind === "query") queries.push(entry);
        else actions.push({ ...entry, requiresConfirmation: isDestructive({ name: proc.path }), bodyFields: [] });
      }
    }
    return { queries, actions };
  },
};
