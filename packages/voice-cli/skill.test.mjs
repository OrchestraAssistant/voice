import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { installSkill, SKILL_NAME } from "./skill.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Run installSkill with cwd pointed at a throwaway dir. */
function inDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "skill-"));
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return fn(dir);
  } finally {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("installing the voice skill", () => {
  test("writes the shipped SKILL.md into .claude/skills, version-locked", () => {
    inDir((dir) => {
      installSkill([]);
      const path = join(dir, ".claude", "skills", SKILL_NAME, "SKILL.md");
      assert.ok(existsSync(path), "skill written where Claude Code discovers it");
      const body = readFileSync(path, "utf8");
      // It is the real skill: discoverable frontmatter, the whole workflow, and
      // the flag worklist the judgement pass operates on.
      assert.match(body, new RegExp(`^---[\\s\\S]*name: ${SKILL_NAME}`));
      assert.match(body, /voice-cli/); // generate
      assert.match(body, /voice-probe/); // probe
      assert.match(body, /manifest\.overlay\.json/); // the judgement pass writes here
      assert.match(body, /review|confidence|bodyFields/); // the worklist
    });
  });

  test("--print emits the skill without writing a file", () => {
    inDir((dir) => {
      // installSkill([--print]) writes to stdout; just assert it does not install.
      installSkill(["--print"]);
      assert.equal(existsSync(join(dir, ".claude")), false, "--print installs nothing");
    });
  });
});

describe("the two skill copies stay in sync", () => {
  test("the package copy is byte-identical to the repo-root canonical", () => {
    // Two real files by necessity: `skills add` reads the repo root over GitHub,
    // npm ships the package copy. A symlink would break the GitHub read, so this
    // guards the drift instead.
    const pkgCopy = join(HERE, "skills", SKILL_NAME, "SKILL.md");
    const rootCopy = join(HERE, "..", "..", "skills", SKILL_NAME, "SKILL.md");
    assert.ok(existsSync(rootCopy), "the repo-root copy exists for `skills add`");
    assert.equal(readFileSync(pkgCopy, "utf8"), readFileSync(rootCopy, "utf8"), "copies drifted -- resync them");
  });
});
