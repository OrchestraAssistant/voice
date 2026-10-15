import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "generate.js");

/** A throwaway app directory, since every case here is about what the tool
 *  does when run from somewhere that is not this repo. */
function app(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "voice-cli-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

// Both streams, always. The diagnostics are warnings, so a helper that reads
// only stdout sees a successful run as silent -- which is what it is NOT.
const run = (cwd, args = []) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

describe("running it the way a consumer would", () => {
  test("defaults resolve from the caller's directory, not from the package", () => {
    // The bug this exists for: the defaults used to resolve relative to
    // generate.js, to a sibling app that existed only in our own repo and
    // nowhere else. `npx @expert/voice-cli` therefore worked for us and for no one who
    // installed it, and nothing caught that because our own invocation passed
    // explicit paths through a workspace script.
    const root = app({ "src/App.jsx": '<Route path="/things" element={<Things/>} />' });
    const { code } = run(root);
    assert.equal(code, 0);
    assert.ok(existsSync(join(root, ".voice/manifest.json")), "wrote nothing where the caller stands");
    const manifest = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    assert.deepEqual(manifest.routes, [{ path: "/things", component: "Things" }]);
  });

  test("explicit paths still win", () => {
    const root = app({ "app/App.jsx": '<Route path="/x" element={<X/>} />' });
    assert.equal(run(root, ["app", "out"]).code, 0);
    assert.ok(existsSync(join(root, "out/manifest.json")));
  });

  test("a source directory that was asked for and is not there is an error", () => {
    // An explicit path that does not exist is a typo. A MISSING `src/` is not:
    // plenty of apps keep their source at the root, so that falls back to `.`
    // rather than refusing to run.
    const { code, out } = run(app(), ["definitely-not-here"]);
    assert.equal(code, 1);
    assert.match(out, /No source directory/);
    assert.doesNotMatch(out, /ENOENT|at Object\./, "raw exception leaked to the user");
  });

  test("an app it cannot read names every detector and what each looked for", () => {
    // Finding nothing is a legitimate outcome -- the widget still has its DOM
    // tools -- but silence about why is how a user concludes the product is
    // broken. Every detector reports, including the ones that found nothing.
    const root = app({ "src/main.tsx": "export const nothing = 1;", "package.json": "{}" });
    const { code, out } = run(root);
    assert.equal(code, 0, "an unrecognised app is not an error");
    for (const detector of ["react-router", "next-app-router", "next-pages-router", "request-hooks", "zod-bodies"]) {
      assert.match(out, new RegExp(detector), `${detector} did not report at all`);
    }
    assert.match(out, /Nothing was extracted/);
  });

  test("--help explains itself without needing an app at all", () => {
    const { code, out } = run(app(), ["--help"]);
    assert.equal(code, 0);
    assert.match(out, /npx @expert\/voice-cli/);
  });
});

describe("what gets published", () => {
  test("the tarball ships the code and excludes tests", () => {
    // Assert the OUTCOME, not the mechanism: this package ships via .npmignore
    // (deny-list), not a `files` allow-list, so what matters is what `npm pack`
    // actually puts in the tarball. The analyser is a core plus a directory per
    // framework, and a published package missing frameworks/ would resolve
    // nothing at all; a published package carrying test/ ships dead weight.
    const pkgDir = dirname(CLI);
    const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
    const res = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: pkgDir, encoding: "utf8" });
    assert.equal(res.status, 0, `npm pack failed: ${res.stderr}`);
    const shipped = JSON.parse(res.stdout)[0].files.map((f) => f.path);

    // Every top-level source dir the code imports must ship, or the tarball
    // crashes on load -- browsers/ was imported by readiness.js and once omitted.
    const dirs = readdirSync(pkgDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !["node_modules", "test"].includes(e.name))
      .map((e) => e.name);
    for (const d of dirs) assert.ok(shipped.some((f) => f.startsWith(`${d}/`)), `tarball is missing the '${d}/' directory`);
    for (const bin of ["generate.js", "probe.js", "skill.js"]) {
      assert.ok(shipped.includes(bin), `tarball is missing the bin ${bin}`);
    }
    // ...and nothing test-shaped, which a deny-list is exactly prone to leaking.
    assert.ok(!shipped.some((f) => f.endsWith(".test.mjs")), "test files must not be published");
    assert.ok(!shipped.some((f) => f === "test" || f.startsWith("test/")), "the test/ dir must not be published");
    assert.equal(pkg.bin["voice-cli"], "./generate.js");
  });
});

describe("detectors are separate and additive", () => {
  test("Next.js routes come from the filesystem, both routers at once", () => {
    // An app mid-migration genuinely has both, which is the common case rather
    // than an edge one. Groups in parentheses organise files without appearing
    // in the URL; [param] is dynamic; @slot is a parallel route rendered into
    // a layout rather than navigated to.
    const root = app({
      "package.json": JSON.stringify({ dependencies: { next: "16.0.0" } }),
      "app/page.tsx": "export default function P(){}",
      "app/(main)/bookings/[status]/page.tsx": "export default function P(){}",
      "app/@modal/thing/page.tsx": "export default function P(){}",
      "app/docs/[...slug]/page.tsx": "export default function P(){}",
      "pages/legacy/[id].tsx": "export default function P(){}",
      "pages/_app.tsx": "export default function P(){}",
      "pages/api/thing.ts": "export default function h(){}",
    });
    const { out } = run(root, ["."]);
    const manifest = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    const paths = manifest.routes.map((r) => r.path).sort();

    assert.ok(paths.includes("/"), "the root page");
    assert.ok(paths.includes("/bookings/:status"), "route group dropped, [param] converted");
    assert.ok(paths.includes("/docs/*"), "catch-all became a wildcard");
    assert.ok(paths.includes("/legacy/:id"), "the Pages Router was read too");
    assert.ok(!paths.some((p) => p.includes("@modal")), "a parallel route is not a destination");
    assert.ok(!paths.some((p) => p.includes("_app")), "framework plumbing is not a destination");
    assert.ok(!paths.some((p) => p.startsWith("/api")), "API routes are not pages");
    assert.match(out, /next-app-router/);
  });

  test("a plain React app with a pages/ folder is not a Next.js app", () => {
    // This fired for real: the demo app keeps components in src/pages/, a
    // directory name with no framework meaning, and the Pages Router detector
    // claimed four routes from it. A detector firing on a coincidence is worse
    // than one finding nothing, because the result looks real.
    const root = app({
      "package.json": JSON.stringify({ dependencies: { react: "18" } }),
      "src/pages/Dashboard.jsx": "export default function D(){}",
    });
    const { out } = run(root);
    assert.match(out, /next-pages-router\s+does not apply/);
    const manifest = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    assert.deepEqual(manifest.routes, []);
  });

  test("a query string in a ternary is a parameter, not part of the path", () => {
    // The real shape: `${BASE}/tasks${search ? `?search=${search}` : ""}`.
    // The ternary is not an identifier, and the old reader emitted it as
    // {param1} marked REQUIRED, producing "/api/tasks{param1}" -- an endpoint
    // no request could satisfy. The name is legible in the nested template.
    const root = app({
      "package.json": "{}",
      "src/api.js": `
        const BASE = "/api";
        async function request(url, options) {}
        export function useTasks(search) {
          return useQuery({ queryFn: () => request(\`\${BASE}/tasks\${search ? \`?search=\${search}\` : ""}\`) });
        }`,
    });
    run(root);
    const manifest = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    const tasks = manifest.queries.find((q) => q.name === "tasks");
    assert.equal(tasks.endpoint, "/api/tasks", "the unreadable expression leaked into the path");
    assert.deepEqual(tasks.params, [{ name: "search", type: "string", required: false, source: "query-string" }]);
  });

  test("the source a param carries is one the widget actually acts on", () => {
    // It used to emit "hook-arg", which nothing reads, so every filter it
    // found was dropped silently at request time.
    const root = app({
      "package.json": "{}",
      "src/api.js": `
        async function request(url) {}
        export const useThing = (id) => useQuery({ queryFn: () => request(\`/api/things/\${id}\`) });`,
    });
    run(root);
    const manifest = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    assert.equal(manifest.queries[0].name, "thing", "an arrow-function hook was skipped");
    assert.deepEqual(manifest.queries[0].params[0].source, "url");
  });

  test("a write action with no body is called out, not shipped quietly", () => {
    const root = app({
      "package.json": "{}",
      "src/api.js": `
        async function request(url, o) {}
        export function useUpdateThing() {
          return useMutation({ mutationFn: (v) => request("/api/things/1", { method: "PUT" }) });
        }`,
    });
    const { out } = run(root);
    assert.match(out, /no body fields/);
    assert.match(out, /cannot change anything/);
  });
});

describe("hand corrections survive regeneration", () => {
  test("the overlay is read, not overwritten", () => {
    // The generated file used to carry a field asking people not to run the
    // generator again, because doing so destroyed their corrections. That is a
    // workflow that punishes improving the thing.
    const root = app({
      "package.json": "{}",
      "src/api.js": `
        async function request(url) {}
        export function useTasks() { return useQuery({ queryFn: () => request("/api/tasks") }); }`,
      ".voice/manifest.overlay.json": JSON.stringify({
        queries: [{ name: "tasks", description: "List every task, newest first" }],
      }),
    });
    const { out } = run(root);
    const manifest = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    assert.equal(manifest.queries[0].description, "List every task, newest first");
    assert.match(out, /hand-corrections: 1 correction\(s\)/);
    // And the overlay itself is untouched.
    const overlay = JSON.parse(readFileSync(join(root, ".voice/manifest.overlay.json"), "utf8"));
    assert.equal(overlay.queries[0].description, "List every task, newest first");
  });

  test("an overlay can describe what no detector found", () => {
    // The escape hatch that matters: an app whose data layer nothing
    // understands can still be described entirely by hand.
    const root = app({
      "package.json": "{}",
      ".voice/manifest.overlay.json": JSON.stringify({
        actions: [{ name: "archive", method: "POST", endpoint: "/api/archive", description: "Archive it", params: [], bodyFields: [] }],
      }),
    });
    const { out } = run(root);
    const manifest = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    assert.equal(manifest.actions[0].name, "archive");
    assert.match(out, /which no detector found/, "adding by hand should be visible, not silent");
  });

  test("a stale overlay entry is reported rather than silently added", () => {
    const root = app({
      "package.json": "{}",
      ".voice/manifest.overlay.json": JSON.stringify({ queries: [{ name: "renamedAwayLongAgo", description: "x" }] }),
    });
    const { out } = run(root);
    assert.match(out, /renamedAwayLongAgo/);
    assert.match(out, /which no detector found/);
  });
});

describe("Next.js API layers", () => {
  test("route handlers give the URL and the method with nothing inferred", () => {
    // The easiest endpoints in any framework to read: the filesystem is the
    // URL and the exported function names are the verbs. A React Router app
    // makes us infer both from a fetch call.
    const root = app({
      "package.json": JSON.stringify({ dependencies: { next: "16" } }),
      "app/api/tasks/route.ts": `
        export async function GET(req) {
          const status = req.nextUrl.searchParams.get("status");
        }
        export async function POST(req) {}`,
      "app/api/tasks/[id]/route.ts": "export async function DELETE(req) {}",
    });
    run(root, ["."]);
    const m = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));

    const list = m.queries.find((q) => q.endpoint === "/api/tasks");
    assert.ok(list, "GET became a query");
    assert.deepEqual(list.params, [{ name: "status", type: "string", required: false, source: "query-string" }]);

    assert.ok(m.actions.some((a) => a.endpoint === "/api/tasks" && a.method === "POST"));
    const remove = m.actions.find((a) => a.method === "DELETE");
    assert.equal(remove.endpoint, "/api/tasks/{id}");
    assert.equal(remove.requiresConfirmation, true, "DELETE must be staged for confirmation");
    assert.deepEqual(remove.params, [{ name: "id", type: "string", required: true, source: "url" }]);
  });

  test("a pages API handler has its methods read out of its branches", () => {
    // One default export serves every verb and branches on req.method, so
    // there are no per-verb exports to read.
    const root = app({
      "package.json": JSON.stringify({ dependencies: { next: "14" } }),
      "pages/api/things/[id].ts": `
        export default function handler(req, res) {
          if (req.method === "GET") return res.json({});
          switch (req.method) { case "PUT": return res.json({}); }
        }`,
    });
    run(root, ["."]);
    const m = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    assert.ok(m.queries.some((q) => q.endpoint === "/api/things/{id}" && q.method === "GET"));
    assert.ok(m.actions.some((a) => a.method === "PUT"));
  });

  test("a handler with no branch is assumed to read, never to write", () => {
    // Guessing a write would invent an operation nobody wrote.
    const root = app({
      "package.json": JSON.stringify({ dependencies: { next: "14" } }),
      "pages/api/whatever.ts": "export default function handler(req, res) { res.json({}); }",
    });
    run(root, ["."]);
    const m = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    assert.equal(m.actions.length, 0);
    assert.equal(m.queries[0].method, "GET");
  });
});

describe("discovery is not exposure", () => {
  const infra = () =>
    app({
      "package.json": JSON.stringify({ dependencies: { next: "16" } }),
      "app/api/cron/reminders/route.ts": "export async function POST(){}",
      "app/api/auth/callback/route.ts": "export async function GET(){}",
      "app/api/trpc/[trpc]/route.ts": "export async function GET(){}",
      "app/api/bookings/route.ts": "export async function GET(){}",
    });

  test("machinery is left out, and said out loud", () => {
    // Reading cal.diy turned up 84 endpoints including cron jobs, OAuth
    // handshakes and webhook receivers. Nobody asks for those by voice, and
    // the tool list rides in the session prompt: they took the prefix from
    // ~2,500 tokens to ~10,900, paid on the first response of every session.
    const { out } = run(infra(), ["."]);
    assert.match(out, /infrastructure: \d+ endpoint\(s\) left out/);
    assert.match(out, /scheduled jobs the app calls itself/, "excluding silently would be worse than not excluding");
  });

  test("what a person would actually ask for survives", () => {
    const root = infra();
    run(root, ["."]);
    const m = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    const endpoints = [...m.queries, ...m.actions].map((x) => x.endpoint);
    assert.ok(endpoints.includes("/api/bookings"), "a real endpoint was filtered away");
    assert.ok(!endpoints.some((e) => e.startsWith("/api/cron")));
    assert.ok(!endpoints.some((e) => e.startsWith("/api/trpc")));
    assert.ok(!endpoints.some((e) => e.includes("/callback")));
  });

  test("naming one in the overlay keeps it", () => {
    // The exclusion is a default, not a verdict. Naming an endpoint in the
    // overlay is a deliberate act and outranks the policy.
    const root = app({
      "package.json": JSON.stringify({ dependencies: { next: "16" } }),
      "app/api/cron/reminders/route.ts": "export async function POST(){}",
      ".voice/manifest.overlay.json": JSON.stringify({
        actions: [{ name: "createCronReminders", description: "Kick off the reminder job by hand" }],
      }),
    });
    run(root, ["."]);
    const m = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    assert.ok(m.actions.some((a) => a.name === "createCronReminders"), "the overlay did not outrank the exclusion");
  });
});

describe("TypeScript types close the body gap", () => {
  const tsApp = (extra = {}) =>
    app({
      "package.json": "{}",
      "src/api.ts": `
        async function request(url: string, o?: RequestInit) {}
        export function useUpdateTask() {
          return useMutation({ mutationFn: (v) => request(\`/api/tasks/\${v.id}\`, { method: "PUT" }) });
        }`,
      ...extra,
    });

  test("an interface named for the action supplies its body", () => {
    // Zod was the first answer and it is the wrong dependency: a validation
    // library is one way an app MIGHT describe its data, while a type is how a
    // TypeScript app describes its data by definition. A Zod schema exists in
    // order to produce one.
    const root = tsApp({
      "src/types.ts": `export interface UpdateTaskInput {
        id: string;
        title?: string;
        done?: boolean;
        priority?: "low" | "high";
      }`,
    });
    const { out } = run(root);
    const m = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    const update = m.actions.find((a) => a.name === "updateTask");

    assert.match(out, /body fields from TypeScript/);
    assert.equal(update.bodyFields.find((f) => f.name === "title").required, false, "`?:` is exact optionality, not a guess");
    assert.equal(update.bodyFields.find((f) => f.name === "done").type, "boolean");
    const priority = update.bodyFields.find((f) => f.name === "priority");
    assert.equal(priority.type, "enum");
    assert.deepEqual(priority.enumValues, ["low", "high"], "a union of string literals tells the model which values are legal");
  });

  test("a URL parameter is not repeated in the body", () => {
    // It is already carried in `params`. Repeating it would tell the model to
    // send the id twice, in two places, and one of them would be wrong.
    const root = tsApp({ "src/types.ts": "export interface UpdateTaskInput { id: string; title?: string; }" });
    run(root);
    const m = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    const update = m.actions.find((a) => a.name === "updateTask");
    assert.deepEqual(update.params.map((p) => p.name), ["id"]);
    assert.deepEqual(update.bodyFields.map((f) => f.name), ["title"]);
  });

  test("a member expression in the URL is a parameter, not a hole", () => {
    // `${variables.id}` is at least as common as a bare identifier, since a
    // mutation receives one object. Dropping it left "/api/tasks/" with a
    // dangling slash and nothing addressable.
    const root = tsApp();
    run(root);
    const m = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    assert.equal(m.actions[0].endpoint, "/api/tasks/{id}");
  });

  test("an explicit schema outranks a type that merely shares a name", () => {
    // Zod runs first and TypeScript only fills what is still empty: writing a
    // schema is a statement of intent about the wire, and a type sharing a
    // name is a correlation.
    const root = tsApp({
      "src/types.ts": "export interface UpdateTaskInput { fromType: string; }",
      "src/Form.jsx": `
        const schema = z.object({ fromSchema: z.string() });
        export function Form() { const m = useUpdateTask(); }`,
    });
    run(root);
    const m = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    assert.deepEqual(m.actions[0].bodyFields.map((f) => f.name), ["fromSchema"]);
  });

  test("no matching type leaves the action honestly empty", () => {
    // Guessing a body from an unrelated type would be worse than none: the
    // warning is what tells someone to write an overlay.
    const root = tsApp({ "src/types.ts": "export interface SomethingElse { a: string; }" });
    const { out } = run(root);
    const m = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    assert.deepEqual(m.actions[0].bodyFields, []);
    assert.match(out, /no body fields/);
  });
});

describe("tRPC procedures, which have no URLs in the source", () => {
  const trpcApp = (extra = {}) =>
    app({
      "package.json": JSON.stringify({ dependencies: { next: "16", "@trpc/server": "11" } }),
      "server/routers.ts": `
        export const scheduleRouter = router({
          get: authedProcedure.input(ZGetScheduleInput).query(async () => {}),
          update: authedProcedure.input(ZUpdateScheduleInput).mutation(async () => {}),
        });
        export const availabilityRouter = router({
          list: authedProcedure.query(async () => {}),
          delete: authedProcedure.input(ZDeleteInput).mutation(async () => {}),
          schedule: scheduleRouter,
        });`,
      "schemas.ts": `
        export const ZUpdateScheduleInput = z.object({ id: z.number(), name: z.string().optional() });`,
      "pages/api/trpc/availability/[trpc].ts": `
        import { availabilityRouter } from "../../../../server/routers";
        export default createNextApiHandler(availabilityRouter);`,
      ...extra,
    });

  test("procedures are read from the router, and the URL from the mount", () => {
    // There is no URL in the client code to find: tRPC calls procedures by
    // path and the transport is an implementation detail. Reading the SERVER
    // is what makes this tractable at all.
    const root = trpcApp();
    run(root, ["."]);
    const m = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));

    const list = m.queries.find((q) => q.name === "availabilityList");
    assert.ok(list, "a .query() procedure did not become a query");
    assert.equal(list.endpoint, "/api/trpc/availability/list");
    assert.equal(list.transport, "trpc", "the widget cannot call this as plain REST");
  });

  test("a nested router becomes a dotted path", () => {
    // `schedule: scheduleRouter` nests, and the real URL cal.diy serves is
    // /api/trpc/availability/schedule.update.
    const root = trpcApp();
    run(root, ["."]);
    const m = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    assert.ok(m.actions.some((a) => a.endpoint === "/api/trpc/availability/schedule.update"));
  });

  test("the namespace is in the tool name, because procedure names repeat", () => {
    // `create`, `update` and `delete` appear in nearly every router -- cal.diy
    // has four of each. Names built from the procedure alone collide, and two
    // different endpoints become one tool.
    const root = trpcApp();
    run(root, ["."]);
    const m = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    assert.ok(m.actions.some((a) => a.name === "availabilityDelete"), "the namespace was dropped from the name");
    assert.ok(!m.actions.some((a) => a.name === "delete"));
  });

  test("routers are found whether written router(), t.router(), or createTRPCRouter()", () => {
    // Only a bare `router(` was matched before, so a stock `t.router({...})` or
    // `createTRPCRouter({...})` app yielded ZERO procedures -- and the empty
    // result sent the search walking up into parent directories to look for them.
    const root = trpcApp({
      "server/routers.ts": `
        export const scheduleRouter = createTRPCRouter({
          update: authedProcedure.input(ZUpdateScheduleInput).mutation(async () => {}),
        });
        export const availabilityRouter = t.router({
          list: authedProcedure.query(async () => {}),
          schedule: scheduleRouter,
        });`,
    });
    run(root, ["."]);
    const m = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    assert.ok(m.queries.some((q) => q.name === "availabilityList"), "t.router() procedures were not found");
    assert.ok(
      m.actions.some((a) => a.endpoint === "/api/trpc/availability/schedule.update"),
      "createTRPCRouter() nested procedures were not found",
    );
  });

  test("a procedure names its own input schema, so nothing is guessed", () => {
    // The producer KNOWS: `.input(ZUpdateScheduleInput)` says exactly which
    // schema describes the body. That beats matching on a shared name.
    const root = trpcApp();
    const { out } = run(root, ["."]);
    const m = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    const update = m.actions.find((a) => a.name === "availabilityScheduleUpdate");
    assert.deepEqual(update.bodyFields.map((f) => f.name), ["id", "name"]);
    assert.equal(update.bodyFields.find((f) => f.name === "name").required, false);
    assert.match(out, /from ZUpdateScheduleInput/);
  });

  test("the transport handler is excluded but its procedures are not", () => {
    // The Next detector sees pages/api/trpc/availability/[trpc].ts and calls
    // it infrastructure, correctly. A blanket /api/trpc rule filtered all 172
    // real procedures away with it.
    const root = trpcApp();
    run(root, ["."]);
    const m = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    const endpoints = [...m.queries, ...m.actions].map((x) => x.endpoint);
    assert.ok(!endpoints.some((e) => e.includes("{trpc}")), "the catch-all handler shipped as a tool");
    assert.ok(endpoints.includes("/api/trpc/availability/list"), "the procedures went with it");
  });

  test("a plain Next app is not searched for routers", () => {
    const root = app({
      "package.json": JSON.stringify({ dependencies: { next: "16" } }),
      "app/page.tsx": "export default function P(){}",
    });
    const { out } = run(root, ["."]);
    assert.match(out, /trpc-routers\s+does not apply/);
  });
});

describe("choosing what ships, when there is too much of it", () => {
  test("an include list narrows the manifest", () => {
    // cal.diy yields 177 readable operations, ~11,700 tokens of prompt prefix
    // paid on the first response of every session. 177 choices is also not
    // obviously easier for a model than 20. Selecting belongs to whoever knows
    // which twenty matter.
    const root = app({
      "package.json": "{}",
      "src/api.js": `
        async function request(u, o) {}
        export function useTasks() { return useQuery({ queryFn: () => request("/api/tasks") }); }
        export function useSecrets() { return useQuery({ queryFn: () => request("/api/secrets") }); }`,
      ".voice/manifest.overlay.json": JSON.stringify({ include: ["tasks"] }),
    });
    run(root);
    const m = JSON.parse(readFileSync(join(root, ".voice/manifest.json"), "utf8"));
    assert.deepEqual(m.queries.map((q) => q.name), ["tasks"]);
  });

  test("without one, a large manifest says what it will cost", () => {
    const many = Object.fromEntries(
      Array.from({ length: 45 }, (_, i) => [`src/api${i}.js`, `
        async function request(u) {}
        export function useThing${i}() { return useQuery({ queryFn: () => request("/api/t${i}") }); }`]),
    );
    const { out } = run(app({ "package.json": "{}", ...many }));
    assert.match(out, /tools is a lot/);
    assert.match(out, /tokens of prompt prefix/);
    assert.match(out, /include/);
  });
});
