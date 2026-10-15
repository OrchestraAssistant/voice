import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

describe("the install links track the release", () => {
  test("the skill and agent guide install the version this package is", () => {
    // Both are read from GitHub by agents with nothing installed yet, so their
    // tarball URLs must name the release that matches this package's version.
    const { version } = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
    const docs = [
      join(HERE, "skills", SKILL_NAME, "SKILL.md"),
      join(HERE, "..", "..", "docs", "agent-guide.md"),
    ];
    for (const doc of docs) {
      const body = readFileSync(doc, "utf8");
      const tags = [...body.matchAll(/releases\/download\/v([\d.]+)/g)].map((m) => m[1]);
      const tarballs = [...body.matchAll(/expert-voice(?:-cli|-server)?-([\d.]+)\.tgz/g)].map((m) => m[1]);
      assert.ok(tags.length > 0, `${doc} has an install URL`);
      for (const v of [...tags, ...tarballs]) assert.equal(v, version, `${doc} installs v${v}, package is v${version}`);
    }
  });
});

describe("the installed bin", () => {
  test("runs when invoked through a node_modules/.bin symlink", () => {
    // npm links bins via a symlink; a direct-run check on the unresolved path
    // made `npx voice-skill --print` exit 0 having printed nothing.
    const dir = mkdtempSync(join(tmpdir(), "skill-bin-"));
    try {
      const link = join(dir, "voice-skill");
      symlinkSync(join(HERE, "skill.js"), link);
      const out = execFileSync(process.execPath, [link, "--print"], { encoding: "utf8" });
      assert.match(out, new RegExp(`^---[\\s\\S]*name: ${SKILL_NAME}`));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
