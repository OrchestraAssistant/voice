import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "generate.js");

/**
 * The whole pipeline, composed, on the shape that motivated the new producers:
 * React Router v7 config split across files + axios service classes over REST +
 * shared types in a sibling workspace package. This is the "Plane" shape, which
 * every earlier producer was blind to (0 routes / 0 actions). It guards the
 * capabilities against each other -- a new stage that regressed this would fail
 * here even if its own unit test still passed.
 */
function planeishApp() {
  const repo = mkdtempSync(join(tmpdir(), "planeish-"));
  const files = {
    "package.json": '{ "name": "planeish", "private": true, "workspaces": ["apps/*", "packages/*"] }',
    "apps/web/app/routes.ts": `
      import { layout, route } from "@react-router/dev/routes";
      import { coreRoutes } from "./routes/core";
      import { extendedRoutes } from "./routes/extended";
      import { mergeRoutes } from "./routes/helper";
      const merged = mergeRoutes(coreRoutes, extendedRoutes);
      export default [ layout("./layout.tsx", [...merged, route("*", "./not-found.tsx")]) ];`,
    "apps/web/app/routes/core.ts": `
      import { route, index } from "@react-router/dev/routes";
      export const coreRoutes = [
        index("./home.tsx"),
        route(":workspaceSlug/projects", "./projects.tsx"),
        route(":workspaceSlug/projects/:projectId/issues", "./issues.tsx"),
      ];`,
    "apps/web/app/routes/extended.ts": `
      import { route } from "@react-router/dev/routes";
      export const extendedRoutes = [ route(":workspaceSlug/settings", "./settings.tsx") ];`,
    "apps/web/core/services/issue.service.ts": `
      import type { IIssue, TIssuePayload } from "@plane/types";
      export class IssueService extends APIService {
        async getIssues(workspaceSlug: string, projectId: string): Promise<IIssue[]> {
          return this.get(\`/api/workspaces/\${workspaceSlug}/projects/\${projectId}/issues/\`).then(r => r.data);
        }
        async createIssue(workspaceSlug: string, projectId: string, data: TIssuePayload): Promise<IIssue> {
          return this.post(\`/api/workspaces/\${workspaceSlug}/projects/\${projectId}/issues/\`, data).then(r => r.data);
        }
        async deleteIssue(workspaceSlug: string, projectId: string, issueId: string): Promise<void> {
          return this.delete(\`/api/workspaces/\${workspaceSlug}/projects/\${projectId}/issues/\${issueId}/\`).then(r => r.data);
        }
      }`,
    "packages/types/issues.ts": `
      export type TIssuePayload = { name: string; description_html?: string; priority: "high" | "low"; };
      export interface IIssue { id: string; name: string; }`,
  };
  for (const [rel, body] of Object.entries(files)) {
    const full = join(repo, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return join(repo, "apps/web");
}

describe("the Plane shape end to end", () => {
  test("RR-v7 routes + axios services + sibling-package types compose into one manifest", () => {
    const web = planeishApp();
    const r = spawnSync(process.execPath, [CLI, "."], { cwd: web, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const m = JSON.parse(readFileSync(join(web, ".voice/manifest.json"), "utf8"));

    // Routes: merged across core.ts + extended.ts, catch-all dropped, index -> "/".
    assert.deepEqual(
      m.routes.map((x) => x.path).sort(),
      ["/", "/:workspaceSlug/projects", "/:workspaceSlug/projects/:projectId/issues", "/:workspaceSlug/settings"],
    );

    // Verbs split correctly.
    assert.deepEqual(m.queries.map((q) => q.name), ["getIssues"]);
    assert.deepEqual(m.actions.map((a) => a.name).sort(), ["createIssue", "deleteIssue"]);
    assert.equal(m.actions.find((a) => a.name === "deleteIssue").requiresConfirmation, true);

    // The body was typed from the SIBLING workspace package, url params excluded.
    const create = m.actions.find((a) => a.name === "createIssue");
    assert.deepEqual(create.bodyFields.map((f) => f.name).sort(), ["description_html", "name", "priority"]);
    assert.equal(create.bodyFields.find((f) => f.name === "priority").type, "enum");

    // Internal hint fields never ship to the model.
    assert.ok(!("_inputType" in create) && !("_service" in create), "underscore metadata leaked into the manifest");
  });
});
