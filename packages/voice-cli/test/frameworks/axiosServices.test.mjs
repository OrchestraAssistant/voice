import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { axiosServices } from "../../frameworks/rest/axiosServices.js";
import { tsTypes } from "../../schema/typescript.js";

function src(files) {
  const dir = mkdtempSync(join(tmpdir(), "axios-svc-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

const PLANE_ISH = {
  "core/services/issue.service.ts": `
    import { APIService } from "./api.service";
    import type { IIssue, TIssuePayload } from "@plane/types";
    export class IssueService extends APIService {
      constructor() { super(API_BASE_URL); }
      async getIssues(workspaceSlug: string, projectId: string): Promise<IIssue[]> {
        return this.get(\`/api/workspaces/\${workspaceSlug}/projects/\${projectId}/issues/\`)
          .then((r) => r.data).catch((e) => { throw e; });
      }
      async createIssue(workspaceSlug: string, projectId: string, data: TIssuePayload): Promise<IIssue> {
        return this.post(\`/api/workspaces/\${workspaceSlug}/projects/\${projectId}/issues/\`, data)
          .then((r) => r.data);
      }
      async patchIssue(workspaceSlug: string, projectId: string, issueId: string, data: Partial<TIssuePayload>): Promise<IIssue> {
        return this.patch(\`/api/workspaces/\${workspaceSlug}/projects/\${projectId}/issues/\${issueId}/\`, data)
          .then((r) => r.data);
      }
      async deleteIssue(workspaceSlug: string, projectId: string, issueId: string): Promise<void> {
        return this.delete(\`/api/workspaces/\${workspaceSlug}/projects/\${projectId}/issues/\${issueId}/\`)
          .then((r) => r.data);
      }
    }`,
};

describe("axios-services producer", () => {
  test("verbs split into queries and actions with endpoints and url params", () => {
    const { queries, actions } = axiosServices.run({ srcDir: src(PLANE_ISH) });
    assert.deepEqual(queries.map((q) => q.name), ["getIssues"]);
    assert.deepEqual(
      actions.map((a) => a.name).sort(),
      ["createIssue", "deleteIssue", "patchIssue"],
    );
    const get = queries[0];
    assert.equal(get.method, "GET");
    assert.equal(get.endpoint, "/api/workspaces/{workspaceSlug}/projects/{projectId}/issues/");
    assert.deepEqual(get.params.map((p) => p.name), ["workspaceSlug", "projectId"]);
    assert.ok(get.params.every((p) => p.required && p.source === "url"));
  });

  test("delete requires confirmation; writes carry the input type hint", () => {
    const { actions } = axiosServices.run({ srcDir: src(PLANE_ISH) });
    const del = actions.find((a) => a.name === "deleteIssue");
    assert.equal(del.method, "DELETE");
    assert.equal(del.requiresConfirmation, true);
    const create = actions.find((a) => a.name === "createIssue");
    assert.equal(create.method, "POST");
    assert.equal(create._inputType, "TIssuePayload");
    assert.equal(create._inputPartial, false);
    const patch = actions.find((a) => a.name === "patchIssue");
    assert.equal(patch._inputPartial, true, "Partial<T> is recorded as partial");
  });

  test("query params from an axios config object", () => {
    const { queries } = axiosServices.run({
      srcDir: src({
        "s.ts": `export class S extends APIService {
          async list(slug: string): Promise<any> {
            return this.get(\`/api/\${slug}/things/\`, { params: { cursor, per_page } }).then((r) => r.data);
          }
        }`,
      }),
    });
    const q = queries[0];
    const names = q.params.map((p) => p.name);
    assert.ok(names.includes("cursor") && names.includes("per_page"));
    assert.ok(q.params.filter((p) => p.source === "query-string").every((p) => !p.required));
  });

  test("colliding method names are namespaced by service; unique ones are not", () => {
    const { queries } = axiosServices.run({
      srcDir: src({
        "a.ts": `export class ProjectService extends APIService {
          async list(): Promise<any> { return this.get("/api/projects/").then(r=>r.data); }
          async getOne(id: string): Promise<any> { return this.get(\`/api/projects/\${id}/\`).then(r=>r.data); }
        }`,
        "b.ts": `export class CycleService extends APIService {
          async list(): Promise<any> { return this.get("/api/cycles/").then(r=>r.data); }
        }`,
      }),
    });
    const names = queries.map((q) => q.name).sort();
    assert.deepEqual(names, ["cycleList", "getOne", "projectList"]);
  });

  test("this.get(nonUrl) is not mistaken for an endpoint", () => {
    const { queries, actions } = axiosServices.run({
      srcDir: src({
        "cache.ts": `export class Store extends APIService {
          async read(key: string) { return this.get(key); }
        }`,
      }),
    });
    assert.equal(queries.length + actions.length, 0);
  });
});

describe("typescript enricher honours the _inputType hint", () => {
  test("resolves a type in a SIBLING package (monorepo), unwrapping Partial", () => {
    // srcDir holds the service; the types live in a sibling workspace package,
    // reachable only from the repo root -- like @plane/types.
    const repo = mkdtempSync(join(tmpdir(), "mono-"));
    const web = join(repo, "apps/web");
    mkdirSync(join(web, "core"), { recursive: true });
    writeFileSync(join(repo, "package.json"), '{"workspaces":["apps/*","packages/*"]}');
    mkdirSync(join(repo, "packages/types"), { recursive: true });
    writeFileSync(
      join(repo, "packages/types/issues.d.ts"),
      `export type TIssuePayload = { name: string; description?: string; priority: "low" | "high"; };`,
    );
    writeFileSync(
      join(web, "core/issue.service.ts"),
      `export class IssueService extends APIService {
         async createIssue(workspaceSlug: string, data: TIssuePayload): Promise<any> {
           return this.post(\`/api/\${workspaceSlug}/issues/\`, data).then(r=>r.data);
         }
       }`,
    );
    const { actions } = axiosServices.run({ srcDir: web });
    // srcDir alone cannot type it; the enricher widens to the repo root.
    tsTypes.run({ srcDir: web, root: web, actions });
    const create = actions.find((a) => a.name === "createIssue");
    assert.ok(create.bodyFields.length, "body was not filled from the sibling package");
    const byName = Object.fromEntries(create.bodyFields.map((f) => [f.name, f]));
    assert.deepEqual(Object.keys(byName).sort(), ["description", "name", "priority"]);
    assert.equal(byName.priority.type, "enum");
    assert.deepEqual(byName.priority.enumValues, ["low", "high"]);
    assert.ok(!create.bodyFields.some((f) => f.name === "workspaceSlug"), "url param leaked into body");
  });
});
