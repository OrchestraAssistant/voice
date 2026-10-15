import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ROLES, STATIC_ROLES, validateDetector, validateRegistry } from "./contract.js";
import { runDetectors, runProbes, activeExcludes, selectStages } from "./run.js";
import { DETECTORS } from "../registry.js";

const ok = (over = {}) => ({ name: "x", describe: "y", role: "producer", run: () => ({}), ...over });

describe("the detector contract", () => {
  test("every shipped detector satisfies it", () => {
    assert.deepEqual(validateRegistry(DETECTORS), []);
  });

  test("a describe is required, because it is what a user reads on a miss", () => {
    // The one output an app we cannot read produces. Without it the report
    // says a detector found nothing and not what it was looking for, which is
    // how someone concludes the product is broken rather than unsuited.
    assert.match(validateDetector(ok({ describe: "" })).join(), /describe/);
  });

  test("a role is required and must be known", () => {
    assert.match(validateDetector(ok({ role: "whatever" })).join(), /role must be one of/);
  });

  test("exclusion rules must be usable, not just present", () => {
    assert.match(validateDetector(ok({ excludes: [{ pattern: "/api/x", why: "no" }] })).join(), /RegExp/);
    assert.match(validateDetector(ok({ excludes: [{ pattern: /x/ }] })).join(), /why/);
  });

  test("two detectors cannot share a name", () => {
    // Names key the conflict report, so a duplicate would make two different
    // readings look like one.
    assert.match(validateRegistry([ok(), ok()]).join(), /duplicate name/);
  });

  test("a malformed registry fails at the start, not mid-run", () => {
    assert.throws(() => runDetectors([ok({ role: "nonsense" })], {}), /registry is invalid/);
  });
});

describe("the runner", () => {
  test("producers run before enrichers, whatever order the registry is in", () => {
    // Enrichers read what producers found. Ordering used to be a property of
    // the array, so reordering it was enough to make every enricher silently
    // do nothing -- a failure with no error and no missing output, just
    // actions that quietly had no body.
    const order = [];
    const registry = [
      ok({ name: "late-enricher", role: "enricher", run: (ctx) => order.push(`enricher saw ${ctx.actions.length}`) }),
      ok({ name: "early-producer", role: "producer", run: () => (order.push("producer"), { actions: [{ name: "a" }] }) }),
    ];
    runDetectors(registry, {});
    assert.deepEqual(order, ["producer", "enricher saw 1"]);
  });

  test("one detector throwing does not cost the others their results", () => {
    const { results, context } = runDetectors(
      [
        ok({ name: "boom", run: () => { throw new Error("bad day"); } }),
        ok({ name: "fine", run: () => ({ routes: [{ path: "/" }] }) }),
      ],
      {},
    );
    assert.match(results.find((r) => r.detector === "boom").failed, /bad day/);
    assert.equal(context.routes.length, 1);
  });

  test("not applicable is recorded differently from found nothing", () => {
    const { results } = runDetectors([ok({ name: "nope", applies: () => false })], {});
    assert.equal(results[0].skipped, true);
  });
});

describe("exclusion rules belong to the framework that applied", () => {
  test("a framework that did not apply filters nothing", () => {
    // A plain React app must never be filtered by Next.js conventions. The
    // rules used to live in one global list, so every app got every
    // framework's opinions whether or not it used that framework.
    const nextish = ok({
      name: "nextish",
      applies: () => false,
      excludes: [{ pattern: /^\/api\/auth\//, why: "auth" }],
    });
    const { results } = runDetectors([nextish], {});
    assert.deepEqual(activeExcludes([nextish], results), []);
  });

  test("and one that did applies its own", () => {
    const nextish = ok({ name: "nextish", excludes: [{ pattern: /^\/api\/auth\//, why: "auth" }] });
    const { results } = runDetectors([nextish], {});
    assert.equal(activeExcludes([nextish], results).length, 1);
  });
});

describe("stages, not just detectors", () => {
  test("every role a stage can have is known and ordered", () => {
    // Detection was modular from the start; everything after it was a fixed
    // sequence in generate.js. Naming the later steps the same way is what
    // makes them removable and switchable.
    assert.deepEqual(ROLES, ["producer", "enricher", "policy", "probe"]);
    assert.deepEqual(STATIC_ROLES, ["producer", "enricher", "policy"]);
    assert.ok(!STATIC_ROLES.includes("probe"), "a probe needs a running app, so it cannot run at generate time");
  });

  test("policies run after everything that finds or annotates", () => {
    const order = [];
    const stage = (name, role) => ok({ name, role, run: () => (order.push(name), {}) });
    runDetectors([stage("p", "policy"), stage("e", "enricher"), stage("d", "producer")], {});
    assert.deepEqual(order, ["d", "e", "p"]);
  });

  test("a stage can hand something to the ones after it", () => {
    // The overlay names what the exclusion policy must keep; without a way to
    // pass that along, a deliberate include would be filtered by a default.
    const registry = [
      ok({ name: "first", role: "enricher", run: () => ({ named: ["keepMe"] }) }),
      ok({ name: "second", role: "policy", run: (ctx) => ({ notes: [`saw ${ctx.named?.join()}`] }) }),
    ];
    const { results } = runDetectors(registry, {});
    assert.match(results.find((r) => r.detector === "second").found.notes[0], /saw keepMe/);
  });
});

describe("choosing a configuration", () => {
  const registry = [ok({ name: "a" }), ok({ name: "b" }), ok({ name: "c" })];

  test("--only keeps just what was asked for", () => {
    // Comparing nine versions of this tool meant nine git worktrees.
    // Comparing nine configurations should mean nine flags.
    assert.deepEqual(selectStages(registry, { only: ["a", "c"] }).stages.map((s) => s.name), ["a", "c"]);
  });

  test("--without drops it and keeps the rest", () => {
    assert.deepEqual(selectStages(registry, { without: ["b"] }).stages.map((s) => s.name), ["a", "c"]);
  });

  test("a name nobody recognises is reported, not ignored", () => {
    // Silently running everything because a flag was misspelled would make a
    // comparison say the opposite of the truth.
    assert.deepEqual(selectStages(registry, { without: ["typo"] }).unknown, ["typo"]);
  });

  test("asking for nothing runs everything", () => {
    assert.equal(selectStages(registry, {}).stages.length, 3);
  });
});

describe("probe stages", () => {
  const probe = (name, over = {}) => ok({ name, role: "probe", ...over });

  test("a probe never runs at generate time", async () => {
    // It needs a live application and usually a session. Running one during
    // generation would mean every generate carried machinery for a network it
    // never touches.
    const order = [];
    runDetectors([probe("p", { run: () => order.push("probe") }), ok({ name: "d", run: () => order.push("producer") })], {});
    assert.deepEqual(order, ["producer"], "a probe ran in the static pipeline");
  });

  test("a write probe is skipped unless writes are allowed", async () => {
    // Probing a write means performing one. That is the caller's decision to
    // make explicitly, not a default a verification tool takes.
    const stage = probe("writer", { needsWrites: true, run: () => ({ notes: ["ran"] }) });
    const off = await runProbes([stage], { allowWrites: false });
    assert.equal(off.results[0].skipped, true);
    assert.match(off.results[0].why, /--writes/);

    const on = await runProbes([stage], { allowWrites: true });
    assert.deepEqual(on.results[0].found.notes, ["ran"]);
  });

  test("corrections are returned, not applied", async () => {
    // What a probe learns is a suggestion for the overlay, which a person
    // reads in a diff before it becomes prompt content for every session.
    const stage = probe("shapes", {
      run: () => ({ corrections: { queries: [{ name: "tasks", returns: { kind: "array" } }] } }),
    });
    const { corrections } = await runProbes([stage], {});
    assert.deepEqual(corrections.queries, [{ name: "tasks", returns: { kind: "array" } }]);
  });

  test("problems are collected and attributed", async () => {
    const { problems } = await runProbes(
      [probe("reach", { run: () => ({ problems: ["route /gone: the page is not there (404)"] }) })],
      {},
    );
    assert.deepEqual(problems, ["reach: route /gone: the page is not there (404)"]);
  });

  test("one probe throwing does not cost the others their findings", async () => {
    const { results, corrections } = await runProbes(
      [
        probe("boom", { run: () => { throw new Error("connection reset"); } }),
        probe("fine", { run: () => ({ corrections: { routes: [{ path: "/", description: "Home." }] } }) }),
      ],
      {},
    );
    assert.match(results.find((r) => r.detector === "boom").failed, /connection reset/);
    assert.equal(corrections.routes.length, 1);
  });
});

describe("when two stages know the same thing", () => {
  test("the overlay is applied last, so it outranks every stage", async () => {
    // Correct for a person's correction. The danger is that --fix writes
    // machine findings into the same file, where they would inherit that
    // authority without anyone deciding.
    const { handCorrections } = await import("../stages/handCorrections.js");
    assert.equal(handCorrections.role, "policy");
    assert.ok(STATIC_ROLES.indexOf("policy") > STATIC_ROLES.indexOf("enricher"));
  });

  test("an override of what a stage found is reported, not silent", async () => {
    // Silently overwriting is how a stale hand correction outlives the thing
    // it was correcting.
    const { handCorrections } = await import("../stages/handCorrections.js");
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const outDir = mkdtempSync(join(tmpdir(), "overlay-"));
    writeFileSync(
      join(outDir, "manifest.overlay.json"),
      JSON.stringify({ routes: [{ path: "/settings", description: "From the overlay." }] }),
    );
    const manifest = { routes: [{ path: "/settings", description: "From the source." }], queries: [], actions: [] };
    const found = handCorrections.run({ outDir, manifest });

    assert.equal(manifest.routes[0].description, "From the overlay.", "the overlay must still win");
    assert.ok(
      found.notes.some((n) => n.includes("/settings.description")),
      `the override went unmentioned: ${JSON.stringify(found.notes)}`,
    );
  });
});
