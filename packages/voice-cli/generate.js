#!/usr/bin/env node
/**
 * Turns an app's source into .voice/manifest.json.
 *
 * A set of DETECTORS, not one analyser. Each knows one pattern -- a router, a
 * data layer, a schema library -- and contributes what it can. The manifest is
 * the union, and a detector finding nothing is normal rather than a failure.
 *
 * It used to be three hardcoded readings of three hardcoded filenames, which
 * worked for the app it was written against and produced literally nothing for
 * the first real app it met. Adding a framework is now additive.
 */
import fs from "node:fs";
import path from "node:path";

import { STAGES } from "./registry.js";
import { runDetectors, selectStages } from "./core/run.js";
import { merge } from "./core/merge.js";
import { OVERLAY_FILE } from "./core/overlay.js";
import { installSkill } from "./skill.js";
import { stampVersion, contractDiff } from "./core/manifestVersion.js";

// `voice-cli skill` installs the manifest-enrichment skill into the repo, for
// the agent that will run the judgement pass. Dispatched before anything else,
// since it does not read the app's source.
if (process.argv[2] === "skill") {
  installSkill(process.argv.slice(3));
  process.exit(0);
}

const USAGE = `voice-cli -- turn a React app's source into .voice/manifest.json

  npx @expert/voice-cli [srcDir] [outDir]

  srcDir   where the app's source lives   (default: ./src, falling back to .)
  outDir   where the manifest is written  (default: ./.voice)

  --stages            list every stage and what it does
  --only <names>      run only these, comma-separated
  --without <names>   run everything except these
  --check             do not write; regenerate and compare the committed
                      manifest's contractHash to the source. Exit 1 if the
                      app's callable surface has drifted (a CI staleness gate).

  npx @expert/voice-cli skill [--print]
                      install the skill that teaches your agent the whole
                      workflow -- generate, probe, and the judgement pass.
                      (Other agents: npx skills add <repo> --skill expert-voice)

Run it from your app's root. Every stage that fired is listed in the output,
along with every one that found nothing and why. --only and --without exist so
a configuration can be tested by running it rather than by checking out an old
commit.`;

/** Repeatable, comma-separated: --without call-sites,trpc-routers */
const valued = (name) => {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === name) out.push(...(process.argv[++i] ?? "").split(",").filter(Boolean));
  }
  return out;
};

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}

if (process.argv.includes("--stages")) {
  for (const stage of STAGES) console.log(`  ${stage.role.padEnd(9)} ${stage.name.padEnd(21)} ${stage.describe}`);
  process.exit(0);
}

// Relative to the CALLER. These used to resolve relative to this file, to a
// sibling app that existed only in our own repo and nowhere else, so `npx` worked
// for us and for nobody who installed it.
// Positionals are srcDir/outDir; flags (and the value --only/--without consume)
// are not, so `voice-cli --check` does not read "--check" as a source directory.
const positionals = [];
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === "--only" || a === "--without") { i++; continue; }
  if (a.startsWith("-")) continue;
  positionals.push(a);
}
const explicitSrc = positionals[0];
// Falling back to `.` rather than insisting on `src`, because plenty of apps
// do not have one. An explicitly passed path that does not exist is still an
// error -- that is a typo, not a layout.
const SRC_DIR = path.resolve(explicitSrc || (fs.existsSync("src") ? "src" : "."));
const OUT_DIR = path.resolve(positionals[1] || ".voice");
/**
 * The app root, which is where framework conventions are rooted: `app/` and
 * `pages/` sit beside `src/` as often as inside it, and `next.config` sits
 * beside both.
 *
 * Found by walking up to the nearest package.json rather than assuming the
 * parent of srcDir. Running `voice-cli .` from an app directory made the
 * parent the root, which in a monorepo is the workspace folder -- no
 * package.json, no next.config, so a Next.js app reported that the Next
 * detectors did not apply to it.
 */
function findRoot(from) {
  let dir = from;
  for (let i = 0; i < 20; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return from;
}
const ROOT = findRoot(SRC_DIR);

function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`No source directory at ${SRC_DIR}\n\n${USAGE}`);
    process.exit(1);
  }

  const { stages, unknown } = selectStages(STAGES, {
    only: valued("--only"),
    without: valued("--without"),
  });
  for (const name of unknown) console.warn(`  no stage called "${name}"; run --stages to list them`);

  // Producers and enrichers fill a pile; policies reshape the merged result.
  // Merging happens between the two, which is why the runner asks for it here
  // rather than deciding when it happens itself.
  let merged = null;
  const { results, context } = runDetectors(stages, {
    srcDir: SRC_DIR,
    root: ROOT,
    outDir: OUT_DIR,
    stages,
    onPhase(role, ctx, soFar) {
      if (role !== "policy") return null;
      merged = merge(soFar);
      // Internal, carried between stages and never shipped. Stripped from
      // every section rather than the ones that happened to be checked:
      // `_inputSchema` was removed from actions only, and leaked into 15 of
      // cal.diy's queries -- a field the model reads and cannot use.
      for (const kind of ["routes", "queries", "actions"]) {
        for (const item of merged.manifest[kind]) {
          for (const field of Object.keys(item)) if (field.startsWith("_")) delete item[field];
        }
      }
      return { manifest: merged.manifest, results: soFar };
    },
  });
  if (!merged) merged = merge(results);
  const { manifest, conflicts, notes } = merged;

  // Again, AFTER the policies have run. The pass above happens before them,
  // so anything a policy adds -- everything in manifest.overlay.json, which is
  // where hand-written notes live -- kept its underscore field and shipped it
  // to the model. Stripping in one place would be tidier and would run at the
  // wrong time; stripping twice is what makes the rule true.
  for (const kind of ["routes", "queries", "actions"]) {
    for (const item of manifest[kind] ?? []) {
      for (const field of Object.keys(item)) if (field.startsWith("_")) delete item[field];
    }
  }
  for (const r of results) if (r.failed) console.warn(`  ${r.detector} failed: ${r.failed}`);
  const include = context.include ?? null;

  const outFile = path.join(OUT_DIR, "manifest.json");
  // Stamped with what produced it. Comparing versions of this tool meant
  // checking out nine commits; a manifest that says which stages made it can
  // be read back without guessing.
  const stamp = {
    generatedAt: "static-analysis",
    generatedBy: results.filter((r) => !r.skipped && !r.failed).map((r) => r.detector),
  };
  // The app's own one-line identity (app-meta seed, overlay refinement), so the
  // session prompt says what this app IS instead of the relay assuming it.
  const appDescription = context.description ? { description: context.description } : {};
  // `version` (format) + `contractHash` (callable surface) stamped at the top.
  const finalManifest = stampVersion({ ...stamp, ...appDescription, ...manifest });

  // --check: a CI staleness gate. Regenerate (which we just did) and compare the
  // committed manifest's contractHash to this fresh one, writing nothing. A
  // mismatch means the app's callable surface drifted since the manifest was
  // generated; cosmetic edits (descriptions, grouping) do not trip it.
  if (process.argv.includes("--check")) {
    if (!fs.existsSync(outFile)) {
      console.error(`--check: no manifest at ${outFile}. Run \`npx voice-cli\` to create it, then commit it.`);
      process.exit(1);
    }
    const committed = JSON.parse(fs.readFileSync(outFile, "utf8"));
    if (committed.contractHash === finalManifest.contractHash) {
      console.log(`✓ manifest is up to date (contract ${finalManifest.contractHash}).`);
      process.exit(0);
    }
    const { added, removed } = contractDiff(committed, finalManifest);
    console.error(`✗ manifest is STALE -- the app's callable surface changed since it was generated.`);
    console.error(`  committed contract: ${committed.contractHash ?? "(none -- regenerate with this CLI)"}`);
    console.error(`  source contract:    ${finalManifest.contractHash}`);
    for (const k of removed) console.error(`    - removed: ${k}`);
    for (const k of added) console.error(`    + added:   ${k}`);
    if (!added.length && !removed.length) {
      console.error(`    (no operations added or removed -- an endpoint, param, body field or confirmation tier changed)`);
    }
    console.error(`  Regenerate by re-running voice-cli (same args, without --check), then commit ${path.join(OUT_DIR, "manifest.json")}.`);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(finalManifest, null, 2));

  console.log(`Wrote manifest: ${outFile} (contract ${finalManifest.contractHash})`);
  console.log(`  routes:  ${manifest.routes.length}`);
  console.log(`  queries: ${manifest.queries.length}`);
  console.log(`  actions: ${manifest.actions.length} (${manifest.actions.filter((a) => a.requiresConfirmation).length} require confirmation)`);

  console.log("\nStages:");
  for (const { detector, role, found, skipped, failed } of results) {
    const counts = ["routes", "queries", "actions"].map((k) => (found[k] ?? []).length);
    const total = counts.reduce((a, b) => a + b, 0);
    const which = stages.find((d) => d.name === detector);
    const label = `  ${role.padEnd(9)} ${detector.padEnd(21)}`;
    if (failed) console.log(`${label} failed: ${failed}`);
    else if (skipped) console.log(`${label} does not apply to this app`);
    // Counts here, words below. A stage that found nothing countable but has
    // something to say gets its line from the notes loop, not from both.
    else if (total) console.log(`${label} ${counts[0]} routes, ${counts[1]} queries, ${counts[2]} actions`);
    else if (!(found.notes ?? []).length) console.log(`${label} nothing -- looked for ${which.describe}`);
  }
  // Every stage says what it did in its own words, so the report needs no
  // knowledge of which stages exist. Only here: merge used to collect these
  // too, and the two loops printed everything twice.
  for (const note of notes) console.log(`  ${note}`);
  for (const { detector, found } of results) {
    for (const note of found.notes ?? []) console.log(`  ${detector}: ${note}`);
  }

  const uncalled = context.uncalled ?? [];
  if (uncalled.length) {
    console.log(`\nSchedulers, webhooks, public API endpoints and dead code look like this.`);
    console.log(`  A strong hint about what to leave out of "include", not a verdict.`);
  }

  // An action with no body fields can be addressed but carries nothing, which
  // is the failure mode most likely to look like it worked.
  const bodyless = manifest.actions.filter((a) => !a.bodyFields?.length && a.method !== "DELETE");
  if (bodyless.length) {
    console.warn(`\n${bodyless.length} write action(s) have no body fields: ${bodyless.map((a) => a.name).join(", ")}`);
    console.warn("  They can be called but cannot change anything. Add a schema, or fill in bodyFields by hand.");
  }

  const toolCount = manifest.queries.length + manifest.actions.length;
  if (toolCount > 40 && !include) {
    // The tool list rides in the session prompt, so this is a real bill and a
    // real ask of the model, not a tidiness concern.
    const tokens = Math.round(JSON.stringify(manifest).length / 4);
    console.warn(`\n${toolCount} tools is a lot: roughly ${tokens} tokens of prompt prefix, paid on the first`);
    console.warn(`  response of EVERY session, and ${toolCount} choices for the model on every turn.`);
    console.warn(`  Add an "include": ["name", ...] array to ${OVERLAY_FILE} to choose which ones ship.`);
  }

  if (conflicts.length) {
    console.warn(`\n${conflicts.length} disagreement(s) between detectors:`);
    for (const c of conflicts) console.warn(`  ${c.kind} ${c.key} (${c.between.join(" vs ")}): ${c.differences.join("; ")}`);
    console.warn("  Nothing was silently picked. Check which reading is right.");
  }

  if (manifest.routes.length + manifest.queries.length + manifest.actions.length === 0) {
    console.warn(`\nNothing was extracted. Every detector and what it looks for is listed above;` +
      ` an app matching none of them still has the widget's DOM tools.`);
  }
}

main();
