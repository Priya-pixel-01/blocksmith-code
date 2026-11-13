import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJobWorkspace, removeJobWorkspace } from "./isolate.js";

const execFileAsync = promisify(execFile);
const FIXTURE_ROOT = resolve(import.meta.dirname, "../../../../fixtures/aem-boilerplate-xwalk");

test("fixture is present", () => {
  assert.ok(existsSync(FIXTURE_ROOT), `Expected fixture at ${FIXTURE_ROOT}`);
});

async function makeScratchGitRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "blocksmith-isolate-git-"));
  // Local clone (fast, real .git history) so worktree operations never touch the actual fixture checkout.
  await execFileAsync("git", ["clone", "--local", FIXTURE_ROOT, dir]);
  return dir;
}

test("createJobWorkspace on a git repo creates a real worktree on a new branch", async () => {
  const repo = await makeScratchGitRepo();
  const scratchDir = mkdtempSync(join(tmpdir(), "blocksmith-scratch-"));
  try {
    const ws = await createJobWorkspace({
      targetRoot: repo,
      scratchDir,
      jobId: "job_abc123def456",
      blockName: "testimonial-carousel",
      isGitRepo: true,
    });

    assert.equal(ws.isGitWorktree, true);
    assert.equal(ws.branchName, "blocksmith/testimonial-carousel-abc123de");
    assert.ok(existsSync(join(ws.dir, "blocks", "cards", "cards.js")), "worktree should contain the real repo's files");

    const { stdout } = await execFileAsync("git", ["branch", "--show-current"], { cwd: ws.dir });
    assert.equal(stdout.trim(), ws.branchName);

    const { stdout: worktreeList } = await execFileAsync("git", ["worktree", "list"], { cwd: repo });
    assert.ok(worktreeList.includes(ws.dir));

    await removeJobWorkspace(repo, ws);
    assert.equal(existsSync(ws.dir), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test("createJobWorkspace is idempotent — re-running for the same jobId cleans up the stale worktree first", async () => {
  const repo = await makeScratchGitRepo();
  const scratchDir = mkdtempSync(join(tmpdir(), "blocksmith-scratch-"));
  try {
    const first = await createJobWorkspace({ targetRoot: repo, scratchDir, jobId: "job_dup000000", blockName: "hero-banner", isGitRepo: true });
    writeFileSync(join(first.dir, "marker.txt"), "first run");

    const second = await createJobWorkspace({ targetRoot: repo, scratchDir, jobId: "job_dup000000", blockName: "hero-banner", isGitRepo: true });
    assert.equal(second.dir, first.dir);
    assert.equal(existsSync(join(second.dir, "marker.txt")), false, "stale worktree from the first run should have been removed");

    await removeJobWorkspace(repo, second);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test("createJobWorkspace on a non-git folder copies files and symlinks node_modules", async () => {
  const nonGitRoot = mkdtempSync(join(tmpdir(), "blocksmith-nongit-"));
  const scratchDir = mkdtempSync(join(tmpdir(), "blocksmith-scratch-"));
  try {
    mkdirSync(join(nonGitRoot, "blocks", "hero"), { recursive: true });
    writeFileSync(join(nonGitRoot, "blocks", "hero", "hero.js"), "export default function decorate(block) {}");
    mkdirSync(join(nonGitRoot, "node_modules", "some-dep"), { recursive: true });
    writeFileSync(join(nonGitRoot, "node_modules", "some-dep", "index.js"), "module.exports = {};");

    const ws = await createJobWorkspace({ targetRoot: nonGitRoot, scratchDir, jobId: "job_plain0001", blockName: "hero", isGitRepo: false });

    assert.equal(ws.isGitWorktree, false);
    assert.equal(ws.branchName, null);
    assert.ok(existsSync(join(ws.dir, "blocks", "hero", "hero.js")));

    const nodeModulesStat = lstatSync(join(ws.dir, "node_modules"));
    assert.ok(nodeModulesStat.isSymbolicLink(), "node_modules should be a symlink back to the target repo's");

    await removeJobWorkspace(nonGitRoot, ws);
    assert.equal(existsSync(ws.dir), false);
  } finally {
    rmSync(nonGitRoot, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  }
});
