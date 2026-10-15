#!/usr/bin/env node
/**
 * Installs the @expert/voice skill into the app's repo, so the developer's agent
 * -- the one already open with the code loaded -- can run the whole manifest
 * workflow: generate, probe, and the judgement pass.
 *
 * This is one of two delivery channels, and the no-external-tool one. The
 * ecosystem installer `npx skills add <repo> --skill expert-voice` (vercel-labs
 * `skills`) is the other: it pulls from the GitHub repo root, handles many
 * agents natively, and does global installs and updates. This command needs no
 * such tool -- it copies the skill bundled with THIS installed package, so it is
 * version-locked to the manifest format this version emits (a hosted or repo
 * copy could drift from whatever the developer installed). It targets Claude
 * Code's `.claude/skills`; for other agents, use `skills add`, or `--print`.
 *
 * No API key, no service: the skill is a procedure the agent already present
 * runs (DESIGN-PHILOSOPHY 2). The package is what it drives; it is useless
 * without it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_NAME = "expert-voice";
const SKILL_SRC = path.join(HERE, "skills", SKILL_NAME, "SKILL.md");

export function installSkill(argv = []) {
  const body = fs.readFileSync(SKILL_SRC, "utf8");

  // --print: emit to stdout, for piping into an agent that reads no skill format.
  if (argv.includes("--print")) {
    process.stdout.write(body);
    return;
  }

  const rel = path.join(".claude", "skills", SKILL_NAME, "SKILL.md");
  const dest = path.resolve(rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body);
  console.log(`Installed the ${SKILL_NAME} skill -> ${rel}`);
  console.log(`  Claude Code discovers it automatically. It walks generate -> probe -> the judgement pass.`);
  console.log(`  For other agents, install with: npx skills add <this repo> --skill ${SKILL_NAME}`);
}

// Runnable directly as a bin; also dispatched from generate.js's `skill` subcommand.
if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  installSkill(process.argv.slice(2));
}
