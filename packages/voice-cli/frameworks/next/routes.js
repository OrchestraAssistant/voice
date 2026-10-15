import fs from "node:fs";
import path from "node:path";
import { firstDir, walk } from "../../core/parse.js";
import { isNextApp } from "./detect.js";

/**
 * Next.js routes the filesystem, so there is nothing in the source to parse:
 * the directory tree IS the router, resolved by convention at build time.
 *
 * Both routers are supported, and both `src/`-nested and root layouts, because
 * an app can legitimately use any combination -- a Pages Router app migrating
 * to App Router has both at once, and that is the common case rather than an
 * edge one.
 */

/** app/(marketing)/blog/[slug]/page.tsx -> /blog/:slug */
function appRouterPath(relDir) {
  const parts = [];
  for (const segment of relDir.split("/")) {
    if (!segment || segment === ".") continue;
    // (group) organises files without appearing in the URL.
    if (segment.startsWith("(") && segment.endsWith(")")) continue;
    // @slot is a parallel route: rendered into a layout, not navigable itself.
    if (segment.startsWith("@")) return null;
    parts.push(segmentToParam(segment));
  }
  return "/" + parts.join("/");
}

/** [slug] -> :slug, [...rest] -> *, [[...rest]] -> * */
function segmentToParam(segment) {
  const catchAll = segment.match(/^\[\[?\.\.\.(.+?)\]?\]$/);
  if (catchAll) return "*";
  const dynamic = segment.match(/^\[(.+)\]$/);
  return dynamic ? `:${dynamic[1]}` : segment;
}

/** pages/tasks/[id].tsx -> /tasks/:id, pages/index.tsx -> / */
function pagesRouterPath(relFile) {
  const withoutExt = relFile.replace(/\.(t|j)sx?$/, "");
  const parts = withoutExt.split("/").filter(Boolean);
  if (parts[parts.length - 1] === "index") parts.pop();
  return "/" + parts.map(segmentToParam).join("/");
}

export const nextAppRouter = {
  name: "next-app-router",
  role: "producer",
  describe: "app/**/page.tsx, the filesystem as the router",
  applies: ({ root }) => isNextApp(root),

  run({ root }) {
    const appDir = firstDir(root, ["app", "src/app"]);
    if (!appDir) return {};
    const routes = [];
    for (const file of walk(appDir, (n) => /^page\.(t|j)sx?$/.test(n))) {
      const relDir = path.relative(appDir, path.dirname(file));
      const routePath = appRouterPath(relDir);
      if (routePath === null) continue;
      // The file is carried so an enricher can read what the page says about
      // itself. Stripped before the manifest is written.
      routes.push({ path: routePath, component: path.basename(path.dirname(file)) || "home", _file: file });
    }
    return { routes };
  },
};

export const nextPagesRouter = {
  name: "next-pages-router",
  role: "producer",
  describe: "pages/**/*.tsx, the older filesystem router",
  applies: ({ root }) => isNextApp(root),

  run({ root }) {
    const pagesDir = firstDir(root, ["pages", "src/pages"]);
    if (!pagesDir) return {};
    const routes = [];
    for (const file of walk(pagesDir, (n) => /\.(t|j)sx?$/.test(n))) {
      const rel = path.relative(pagesDir, file);
      // _app, _document and _error are framework plumbing, not destinations;
      // api/ is handled by the route-handler detector, not this one.
      if (rel.split("/").some((s) => s.startsWith("_")) || rel.startsWith("api/")) continue;
      routes.push({ path: pagesRouterPath(rel), component: path.basename(file).replace(/\.(t|j)sx?$/, ""), _file: file });
    }
    return { routes };
  },
};
