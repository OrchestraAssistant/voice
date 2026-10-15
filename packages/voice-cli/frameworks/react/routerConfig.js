import path from "node:path";
import traverse from "@babel/traverse";
import { parseFile, walk } from "../../core/parse.js";

/**
 * React Router's CONFIG forms, the two the JSX reader (react-router.js) cannot
 * see because there is no <Route> element to find.
 *
 * 1. Framework mode (`@react-router/dev/routes`, the merged Remix):
 *
 *      import { route, index, layout, prefix } from "@react-router/dev/routes";
 *      export default [
 *        layout("./layout.tsx", [
 *          index("./home.tsx"),
 *          route("issues/:id", "./issue.tsx"),
 *          ...prefix("settings", [ route("members", "./members.tsx") ]),
 *        ]),
 *      ];
 *
 *    Routes are function calls, not elements, and the path is the first string
 *    argument. `index` and `layout` add no path segment of their own; `prefix`
 *    prepends one to its children. This is the shape Plane uses, and the reason
 *    a JSX-only reader extracted 0 routes from it.
 *
 * 2. Data router (`createBrowserRouter`, `useRoutes`):
 *
 *      createBrowserRouter([
 *        { path: "/tasks/:id", element: <Task/>, children: [{ index: true, element: <Detail/> }] },
 *      ]);
 *
 *    Objects rather than elements, keyed `path` / `element` / `Component` /
 *    `children` / `index`.
 *
 * Nesting is joined only where it is written INLINE. Plane splits its tree
 * across files and merges arrays by identifier (`mergeRoutes(coreRoutes, ...)`),
 * which cannot be followed statically -- but each `route(...)` call still lives
 * in some file and is collected when that file is scanned, and the only prefix
 * lost across the seam is a pathless `layout(...)`, which contributes no
 * segment. So the union is complete even when the composition is not readable.
 */

/** react-router path join: an absolute child replaces, a relative one appends. */
function joinPath(prefix, segment) {
  if (segment == null || segment === "") return prefix; // index / layout: no segment
  if (segment.startsWith("/")) return segment.replace(/\/{2,}/g, "/");
  const joined = `${prefix.replace(/\/$/, "")}/${segment}`;
  return joined.replace(/\/{2,}/g, "/");
}

/** A component-ish name from a module path string: "./pages/home.tsx" -> "home". */
function componentFromModule(modulePath) {
  if (typeof modulePath !== "string") return undefined;
  const base = path.basename(modulePath).replace(/\.(t|j)sx?$/, "");
  return base && base !== "index" && base !== "route" ? base : undefined;
}

/** Which of route/index/layout/prefix a file imports from a react-router module. */
function routerHelpers(ast, visit) {
  const helpers = new Set();
  visit(ast, {
    ImportDeclaration(nodePath) {
      const source = nodePath.node.source?.value ?? "";
      // The dev-routes helpers, or the config re-exported from react-router
      // itself. A bare `route()` in unrelated code never matches, because it is
      // the import that qualifies it -- these are ordinary English words.
      if (!/^(@react-router\/dev\/routes|react-router\/dev\/routes|react-router)$/.test(source)) return;
      for (const spec of nodePath.node.specifiers ?? []) {
        const name = spec.imported?.name ?? spec.local?.name;
        if (["route", "index", "layout", "prefix"].includes(name)) helpers.add(name);
      }
    },
  });
  return helpers;
}

/** The first string-literal argument of a call, or null. */
const firstString = (node) => {
  const arg = node.arguments.find((a) => a.type === "StringLiteral");
  return arg ? arg.value : null;
};
/** The first array-literal argument of a call, or null. */
const firstArray = (node) => node.arguments.find((a) => a.type === "ArrayExpression") ?? null;

/**
 * A helper-form call (route/index/layout/prefix), recursed for inline children.
 * Emits into `out` with full joined paths.
 */
function readHelperCall(node, prefix, helpers, out) {
  const callee = node.callee?.name;
  if (!helpers.has(callee)) return;
  const children = firstArray(node);

  if (callee === "prefix") {
    // prefix(path, children): a segment with no page of its own.
    const seg = firstString(node);
    const inner = joinPath(prefix, seg);
    for (const child of children?.elements ?? []) readElement(child, inner, helpers, out);
    return;
  }
  if (callee === "layout") {
    // layout(file, children): groups children, adds no segment.
    for (const child of children?.elements ?? []) readElement(child, prefix, helpers, out);
    return;
  }
  if (callee === "index") {
    // index(file): the parent's own path renders this. A bare index at the top
    // is the site root.
    out.push({ path: prefix || "/", component: componentFromModule(firstString(node)) });
    return;
  }
  // route(path, file, options?, children?)
  const seg = firstString(node);
  const full = joinPath(prefix, seg);
  out.push({ path: full || "/", component: componentFromModule(node.arguments[1]?.value) });
  for (const child of children?.elements ?? []) readElement(child, full, helpers, out);
}

/** A route OBJECT ({ path, element, index, children }), recursed. */
function readObject(node, prefix, out) {
  if (node.type !== "ObjectExpression") return;
  const get = (name) => node.properties.find((p) => (p.key?.name ?? p.key?.value) === name)?.value;
  const pathProp = get("path");
  const indexProp = get("index");
  const elementNode = get("element") ?? get("Component");
  const childrenNode = get("children");

  const seg = pathProp?.type === "StringLiteral" ? pathProp.value : null;
  const full = joinPath(prefix, seg);
  const component =
    elementNode?.type === "JSXElement"
      ? elementNode.openingElement.name?.name
      : elementNode?.type === "Identifier"
        ? elementNode.name
        : undefined;

  // An index route or any route with its own path is a navigable target. A pure
  // layout wrapper (children only, no path) contributes nothing but its prefix.
  if (indexProp?.value === true || (indexProp?.type === "BooleanLiteral" && indexProp.value)) {
    out.push({ path: full || "/", component });
  } else if (seg != null) {
    out.push({ path: full || "/", component });
  }
  for (const child of childrenNode?.elements ?? []) {
    readObject(child?.type === "SpreadElement" ? child.argument : child, full, out);
  }
}

/** Dispatch an array element to whichever reader fits (helper call or object). */
function readElement(node, prefix, helpers, out) {
  if (!node) return;
  // `...prefix("x", [...])` and `...someArray` both arrive as SpreadElement. An
  // inline spread of a call is followed; a spread of an identifier (an array
  // built elsewhere) has no inline node to read -- those routes are collected
  // when their own file is scanned. See the header.
  if (node.type === "SpreadElement") return readElement(node.argument, prefix, helpers, out);
  if (node.type === "CallExpression" && helpers.has(node.callee?.name)) readHelperCall(node, prefix, helpers, out);
  else if (node.type === "ObjectExpression") readObject(node, prefix, out);
}

const DATA_ROUTER = /^(createBrowserRouter|createHashRouter|createMemoryRouter|useRoutes|createRoutesFromElements)$/;

export const reactRouterConfig = {
  name: "react-router-config",
  role: "producer",
  describe: "route()/index()/layout() config, or createBrowserRouter([{ path, element }]) objects",

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
      const helpers = routerHelpers(ast, visit);

      visit(ast, {
        CallExpression(nodePath) {
          const callee = nodePath.node.callee;
          // Helper form: only the TOP-LEVEL call of a nest is entered; its
          // inline children are recursed by hand, so skip the subtree to avoid
          // reading the same `route(...)` twice.
          if (callee?.type === "Identifier" && helpers.has(callee.name)) {
            readHelperCall(nodePath.node, "", helpers, out);
            nodePath.skip();
            return;
          }
          // Data-router form: the array argument is a list of route objects.
          if (callee?.type === "Identifier" && DATA_ROUTER.test(callee.name)) {
            const arr = firstArray(nodePath.node);
            for (const el of arr?.elements ?? []) readElement(el, "", helpers, out);
            nodePath.skip();
          }
        },
      });
    }

    // A catch-all is not a place a person navigates to, and an empty path is
    // the layout root already emitted by its index. Dedupe by path: the merged
    // array pattern legitimately lists the same route from two files.
    const seen = new Set();
    const routes = out.filter((r) => {
      if (!r.path || r.path === "*" || r.path === "/*") return false;
      if (seen.has(r.path)) return false;
      seen.add(r.path);
      return true;
    });
    return { routes };
  },
};
