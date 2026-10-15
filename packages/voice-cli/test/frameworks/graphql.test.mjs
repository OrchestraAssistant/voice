import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { graphqlOperations } from "../../frameworks/graphql/operations.js";

function src(files) {
  const dir = mkdtempSync(join(tmpdir(), "graphql-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return dir;
}

describe("graphql-operations producer", () => {
  test("mutations become actions with typed variables, document and transport", () => {
    const dir = src({
      "ops.ts": `import { gql } from "@apollo/client";
        export const CREATE_TASK = gql\`
          mutation CreateTask($title: String!, $priority: Priority, $tagIds: [ID!]) {
            createTask(input: { title: $title, priority: $priority, tagIds: $tagIds }) { id }
          }\`;`,
    });
    const { actions } = graphqlOperations.run({ srcDir: dir });
    const a = actions.find((x) => x.name === "createTask");
    assert.ok(a, "mutation not found");
    assert.equal(a.transport, "graphql");
    assert.equal(a.method, "POST");
    assert.equal(a.operationName, "CreateTask");
    assert.match(a.document, /mutation CreateTask/);
    const f = Object.fromEntries(a.bodyFields.map((v) => [v.name, v]));
    assert.equal(f.title.type, "string");
    assert.equal(f.title.required, true);
    assert.equal(f.priority.required, false);
    assert.equal(f.tagIds.type, "array");
  });

  test("queries become queries with GET intent (the wire is still POST)", () => {
    const dir = src({
      "q.ts": `import { gql } from "urql";
        export const TASKS = gql\`query Tasks($limit: Int) { tasks(limit: $limit) { id } }\`;`,
    });
    const { queries, actions } = graphqlOperations.run({ srcDir: dir });
    assert.equal(actions.length, 0);
    const q = queries[0];
    assert.equal(q.name, "tasks");
    assert.equal(q.method, "GET");
    assert.equal(q.transport, "graphql");
    assert.equal(q.bodyFields[0].name, "limit");
  });

  test("a delete-ish mutation requires confirmation", () => {
    const dir = src({
      "d.ts": `import { gql } from "graphql-tag";
        export const D = gql\`mutation DeleteTask($id: ID!) { deleteTask(id: $id) }\`;`,
    });
    const { actions } = graphqlOperations.run({ srcDir: dir });
    assert.equal(actions[0].requiresConfirmation, true);
  });

  test("a same-file fragment is inlined, so the interpolated op IS emitted", () => {
    const dir = src({
      "frag.ts": `import { gql } from "@apollo/client";
        const FIELDS = gql\`fragment Fields on Task { id title }\`;
        export const GET = gql\`query GetTask($id: ID!) { task(id: $id) { ...Fields } } \${FIELDS}\`;`,
    });
    const { queries } = graphqlOperations.run({ srcDir: dir });
    const q = queries.find((x) => x.name === "getTask");
    assert.ok(q, "interpolated query with a local fragment was not emitted");
    assert.match(q.document, /query GetTask/);
    assert.match(q.document, /fragment Fields on Task/, "the fragment was not inlined into the document");
    assert.equal(q.bodyFields[0].name, "id");
  });

  test("nested fragments are inlined transitively", () => {
    const dir = src({
      "frag.ts": `import { gql } from "@apollo/client";
        const BASE = gql\`fragment Base on Task { id }\`;
        const FULL = gql\`fragment Full on Task { ...Base title } \${BASE}\`;
        export const GET = gql\`query GetTask($id: ID!) { task(id: $id) { ...Full } } \${FULL}\`;`,
    });
    const q = graphqlOperations.run({ srcDir: dir }).queries.find((x) => x.name === "getTask");
    assert.ok(q);
    assert.match(q.document, /fragment Full on Task/);
    assert.match(q.document, /fragment Base on Task/, "the transitively-referenced fragment was not inlined");
  });

  test("an IMPORTED fragment is resolved across files and inlined", () => {
    const dir = src({
      "fragments.ts": `import { gql } from "@apollo/client";
        export const FIELDS = gql\`fragment Fields on Task { id title status }\`;`,
      "op.ts": `import { gql } from "@apollo/client";
        import { FIELDS } from "./fragments";
        export const GET = gql\`query GetTask($id: ID!) { task(id: $id) { ...Fields } } \${FIELDS}\`;`,
    });
    const q = graphqlOperations.run({ srcDir: dir }).queries.find((x) => x.name === "getTask");
    assert.ok(q, "cross-file fragment was not resolved");
    assert.match(q.document, /fragment Fields on Task { id title status }/);
  });

  test("a fragment imported through a re-export barrel still resolves", () => {
    const dir = src({
      "graphql/fragments.ts": `import { gql } from "@apollo/client";
        export const TASK_FIELDS = gql\`fragment TaskFields on Task { id }\`;`,
      "graphql/index.ts": `export { TASK_FIELDS } from "./fragments";`,
      "op.ts": `import { gql } from "@apollo/client";
        import { TASK_FIELDS } from "./graphql";
        export const GET = gql\`query GetTask { task { ...TaskFields } } \${TASK_FIELDS}\`;`,
    });
    const q = graphqlOperations.run({ srcDir: dir }).queries.find((x) => x.name === "getTask");
    assert.ok(q, "fragment behind a re-export barrel was not resolved");
    assert.match(q.document, /fragment TaskFields on Task/);
  });

  test("a fragment that cannot be found anywhere leaves the op unemitted", () => {
    const dir = src({
      "op.ts": `import { gql } from "@apollo/client";
        import { FIELDS } from "some-unresolvable-pkg";
        export const GET = gql\`query GetTask($id: ID!) { task(id: $id) { ...Fields } } \${FIELDS}\`;`,
    });
    // The import target is not on disk, so the document cannot be reproduced
    // faithfully and the op is read but not emitted -- honest over broken.
    assert.equal(graphqlOperations.run({ srcDir: dir }).queries.length, 0);
  });

  test("subscriptions are skipped; a non-gql tag is ignored", () => {
    const dir = src({
      "s.ts": `import { gql } from "@apollo/client";
        export const SUB = gql\`subscription OnTask { taskAdded { id } }\`;
        const css = styled\`mutation NotReal($x: Int) { y }\`;`,
    });
    const { queries, actions } = graphqlOperations.run({ srcDir: dir });
    assert.equal(queries.length + actions.length, 0);
  });

  test("endpoint is discovered from an Apollo client uri, else defaults to /graphql", () => {
    const discovered = src({
      "client.ts": `import { ApolloClient } from "@apollo/client";
        export const client = new ApolloClient({ uri: "https://api.example.com/graphql", cache });`,
      "ops.ts": `import { gql } from "@apollo/client";
        export const PING = gql\`query Ping { ping }\`;`,
    });
    assert.equal(graphqlOperations.run({ srcDir: discovered }).queries[0].endpoint, "/graphql");

    const dflt = src({ "ops.ts": `import { gql } from "@apollo/client"; export const P = gql\`query P { ping }\`;` });
    assert.equal(graphqlOperations.run({ srcDir: dflt }).queries[0].endpoint, "/graphql");
  });
});
