import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countCallSites, searchTermFor } from "./callsites.js";

describe("what to search for", () => {
  test("a tRPC procedure is never a URL in client code", () => {
    // It is called as trpc.availability.schedule.update.useMutation(), so the
    // dotted path is the only thing that will ever match.
    assert.equal(
      searchTermFor({ endpoint: "/api/trpc/availability/schedule.update", transport: "trpc" }),
      "availability.schedule.update",
    );
  });

  test("a REST endpoint is searched up to its first parameter", () => {
    // Everything after it is interpolated at runtime and appears nowhere.
    assert.equal(searchTermFor({ endpoint: "/api/tasks/{id}" }), "/api/tasks");
  });

  test("a needle too short to mean anything is refused", () => {
    // "/api" would match every file in the app and count as evidence.
    assert.equal(searchTermFor({ endpoint: "/api" }), null);
  });
});

describe("counting", () => {
  const app = () => {
    const root = mkdtempSync(join(tmpdir(), "callsites-"));
    writeFileSync(join(root, "page.tsx"), `
      const tasks = await fetch("/api/tasks");
      const one = await fetch(\`/api/tasks/\${id}\`);
      trpc.availability.list.useQuery();`);
    return root;
  };

  test("an endpoint the app calls is counted, one it never calls is zero", () => {
    // 52 of cal.diy's 177 discovered operations count zero: schedulers,
    // webhooks, endpoints published for third parties, and dead code.
    const counts = countCallSites(
      [
        { name: "tasks", endpoint: "/api/tasks" },
        { name: "version", endpoint: "/api/version" },
        { name: "availabilityList", endpoint: "/api/trpc/availability/list", transport: "trpc" },
      ],
      [app()],
    );
    assert.equal(counts.get("tasks"), 1);
    assert.equal(counts.get("version"), 0);
    assert.equal(counts.get("availabilityList"), 1);
  });

  test("an unsearchable endpoint is null, not zero", () => {
    // Zero means "nothing calls this", which is a claim. Null means "no
    // question was asked", and writing the first when you mean the second is
    // how an endpoint gets pruned for the wrong reason.
    const counts = countCallSites([{ name: "root", endpoint: "/api" }], [app()]);
    assert.equal(counts.get("root"), null);
  });
});
