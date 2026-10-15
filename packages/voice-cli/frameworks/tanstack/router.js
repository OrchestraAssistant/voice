import traverse from "@babel/traverse";
import { parseFile, walk } from "../../core/parse.js";

/**
 * TanStack Router routes, from its two authoring styles.
 *
 * File-based (the common one today) declares each route with the path as a
 * string argument, and TanStack's own param syntax -- a leading `$`:
 *
 *   export const Route = createFileRoute('/posts/$postId')({ component: Post });
 *
 * Code-based passes the path as an option:
 *
 *   const postsRoute = createRoute({ getParentRoute: () => root, path: '/posts' });
 *
 * The `$postId` param is normalised to the `:postId` the widget's navigation
 * already understands (see onPage in domActions.js), and a bare `$` splat is a
 * catch-all, dropped like `*`. Gated on a `@tanstack/*-router` import, tracking
 * whatever local names `createFileRoute` / `createRoute` were bound to, so a
 * function of either name from elsewhere is not mistaken for a route.
 */

/** `/posts/$postId` -> `/posts/:postId`; a lone `$` segment is a splat. */
function normalizePath(p) {
  if (typeof p !== "string" || !p) return null;
  const segments = p.split("/").map((seg) => {
    if (seg === "$") return "*"; // splat / catch-all
    if (seg.startsWith("$")) return `:${seg.slice(1)}`;
    return seg;
  });
  const out = segments.join("/").replace(/\/{2,}/g, "/");
  return out || "/";
}

/** Local names bound to the TanStack route factories in this file. */
function tanstackFactories(ast, visit) {
  const names = new Map(); // localName -> "createFileRoute" | "createRoute" | "createRootRoute"
  visit(ast, {
    ImportDeclaration(nodePath) {
      const source = nodePath.node.source?.value ?? "";
      if (!/^@tanstack\/[\w-]*router$/.test(source)) return;
      for (const spec of nodePath.node.specifiers ?? []) {
        const imported = spec.imported?.name;
        if (["createFileRoute", "createRoute", "createRootRoute", "createLazyFileRoute"].includes(imported)) {
          names.set(spec.local.name, imported);
        }
      }
    },
  });
  return names;
}

const componentName = (node) => (node?.type === "Identifier" ? node.name : node?.type === "JSXElement" ? node.openingElement.name?.name : undefined);

export const tanstackRouter = {
  name: "tanstack-router",
  role: "producer",
  describe: "createFileRoute('/path') / createRoute({ path }) TanStack Router definitions",

  run({ srcDir }) {
    const visit = traverse.default ?? traverse;
    const out = [];

    for (const file of walk(srcDir, (n) => /\.(t|j)sx?$/.test(n))) {
      let ast;
      try {
        ast = parseFile(file);
      } catch {
        continue;
      }
      const factories = tanstackFactories(ast, visit);
      if (!factories.size) continue;

      visit(ast, {
        CallExpression(nodePath) {
          const callee = nodePath.node.callee;
          // Code style: createRoute({ path, component }).
          if (callee?.type === "Identifier" && factories.has(callee.name)) {
            const kind = factories.get(callee.name);
            if (kind === "createRootRoute") return;
            const opts = nodePath.node.arguments[0];
            if (opts?.type !== "ObjectExpression") return;
            const pathProp = opts.properties.find((p) => (p.key?.name ?? p.key?.value) === "path")?.value;
            const compProp = opts.properties.find((p) => (p.key?.name ?? p.key?.value) === "component")?.value;
            const path = normalizePath(pathProp?.type === "StringLiteral" ? pathProp.value : null);
            if (path) out.push({ path, component: componentName(compProp) });
            return;
          }
          // File style: createFileRoute('/path')({ component }). The path is on
          // the INNER call; the options (with the component) on the outer one.
          if (
            callee?.type === "CallExpression" &&
            callee.callee?.type === "Identifier" &&
            factories.has(callee.callee.name) &&
            ["createFileRoute", "createLazyFileRoute"].includes(factories.get(callee.callee.name))
          ) {
            const pathArg = callee.arguments[0];
            const path = normalizePath(pathArg?.type === "StringLiteral" ? pathArg.value : null);
            if (!path) return;
            const opts = nodePath.node.arguments[0];
            const compProp = opts?.type === "ObjectExpression"
              ? opts.properties.find((p) => (p.key?.name ?? p.key?.value) === "component")?.value
              : null;
            out.push({ path, component: componentName(compProp) });
            nodePath.skip(); // don't also read the inner createFileRoute call as code-style
          }
        },
      });
    }

    const seen = new Set();
    const routes = out.filter((r) => {
      if (!r.path || r.path === "*" || r.path.endsWith("/*") || seen.has(r.path)) return false;
      seen.add(r.path);
      return true;
    });
    return { routes };
  },
};
