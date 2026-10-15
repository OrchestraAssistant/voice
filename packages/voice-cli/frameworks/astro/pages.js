import fs from "node:fs";
import { isDestructive } from "../../core/destructive.js";
import path from "node:path";
import traverse from "@babel/traverse";
import { firstDir, parseFile, walk } from "../../core/parse.js";

/**
 * Astro routes the filesystem under `src/pages/`, and a file there is one of two
 * things:
 *
 *   a PAGE      -- .astro / .md / .mdx / .html -- a navigable route
 *   an ENDPOINT -- .ts / .js -- a real HTTP handler, exporting GET/POST/... fns
 *
 * so this one producer yields both: routes (for navigation) and queries/actions
 * (the endpoints, callable over plain HTTP, exactly like Next route handlers).
 * Dynamic segments use Next's spelling -- `[id]`, `[...rest]` -- so a page's
 * `[slug]` becomes `:slug` and an endpoint's becomes a `{slug}` url parameter.
 */

const isAstro = (root) => {
  for (const cfg of ["astro.config.mjs", "astro.config.js", "astro.config.ts", "astro.config.cjs"]) {
    if (fs.existsSync(path.join(root, cfg))) return true;
  }
  try {
    return /"astro"\s*:/.test(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    return false;
  }
};

const PAGE = /\.(astro|md|mdx|markdown|html)$/;
const ENDPOINT = /\.(t|j|mj)s$/;
const WRITE_VERBS = { POST: "create", PUT: "update", PATCH: "update", DELETE: "delete" };

/** The path segments of a page file, or null if it is a catch-all (undestinable). */
function pageSegments(relNoExt) {
  const parts = [];
  for (const seg of relNoExt.split("/")) {
    if (!seg || seg === "index") continue;
    if (/^\[\.\.\..+\]$/.test(seg)) return null; // [...rest] catch-all is not a nav target
    const dyn = seg.match(/^\[(.+)\]$/);
    parts.push(dyn ? `:${dyn[1]}` : seg);
  }
  return parts;
}

/** An endpoint's URL and its url parameters: pages/api/users/[id].ts -> /api/users/{id}. */
function endpointOf(relNoExt) {
  const params = [];
  const segments = [];
  for (const seg of relNoExt.split("/")) {
    if (!seg || seg === "index") continue;
    const dyn = seg.match(/^\[(?:\.\.\.)?(.+)\]$/);
    if (dyn) {
      params.push(dyn[1]);
      segments.push(`{${dyn[1]}}`);
    } else {
      segments.push(seg);
    }
  }
  return { endpoint: "/" + segments.join("/"), params };
}

/** A tool name from a path + verb: /api/users/{id} PATCH -> updateApiUsersById. */
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

/** The HTTP-verb functions an endpoint module exports. */
function exportedVerbs(ast, visit) {
  const verbs = new Set();
  const add = (n) => {
    const v = (n ?? "").toUpperCase();
    if (v === "GET" || v === "ALL" || WRITE_VERBS[v]) verbs.add(v === "ALL" ? "GET" : v); // ALL handles every method; treat as a read
  };
  visit(ast, {
    ExportNamedDeclaration(nodePath) {
      const decl = nodePath.node.declaration;
      if (decl?.type === "FunctionDeclaration" && decl.id) add(decl.id.name);
      if (decl?.type === "VariableDeclaration") for (const d of decl.declarations) if (d.id.type === "Identifier") add(d.id.name);
      for (const spec of nodePath.node.specifiers ?? []) add(spec.exported?.name);
    },
  });
  return verbs;
}

export const astroPages = {
  name: "astro-pages",
  role: "producer",
  describe: "src/pages/** Astro pages (navigation) and .ts/.js endpoints (GET/POST/... handlers)",
  applies: ({ root }) => isAstro(root),

  run({ root }) {
    const pagesDir = firstDir(root, ["src/pages", "pages"]);
    if (!pagesDir) return {};
    const visit = traverse.default ?? traverse;
    const routes = [];
    const queries = [];
    const actions = [];

    for (const file of walk(pagesDir, (n) => PAGE.test(n) || ENDPOINT.test(n))) {
      const base = path.basename(file);
      // One extension per file; strip it and use "/" separators throughout.
      const relNoExt = path.relative(pagesDir, file).split(path.sep).join("/").replace(/\.[^./]+$/, "");

      if (PAGE.test(base)) {
        const segs = pageSegments(relNoExt);
        if (segs === null) continue; // catch-all page
        routes.push({ path: "/" + segs.join("/"), component: base.replace(PAGE, ""), _file: file });
        continue;
      }

      // An endpoint module.
      let ast;
      try {
        ast = parseFile(file);
      } catch {
        continue;
      }
      const verbs = exportedVerbs(ast, visit);
      if (!verbs.size) continue; // a .ts helper in pages/, not an endpoint
      const { endpoint, params: urlParams } = endpointOf(relNoExt);
      for (const method of verbs) {
        const entry = {
          name: nameFrom(endpoint, method),
          description: `Auto-detected ${method} endpoint at ${endpoint} (Astro)`,
          method,
          endpoint,
          params: urlParams.map((p) => ({ name: p, type: "string", required: true, source: "url" })),
        };
        if (method === "GET") queries.push(entry);
        else actions.push({ ...entry, requiresConfirmation: isDestructive({ method, name: entry.name }), bodyFields: [] });
      }
    }
    return { routes, queries, actions };
  },
};
