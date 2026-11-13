import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeResult, isAllowedWriterPath } from "./writer.js";
import { createJobWorkspace, removeJobWorkspace } from "./isolate.js";

const execFileAsync = promisify(execFile);
const FIXTURE_ROOT = resolve(import.meta.dirname, "../../../../fixtures/aem-boilerplate-xwalk");

test("fixture is present", () => {
  assert.ok(existsSync(FIXTURE_ROOT), `Expected fixture at ${FIXTURE_ROOT}`);
});

test("isAllowedWriterPath allows EDS and standard AEM paths; rejects unrelated files", () => {
  assert.equal(isAllowedWriterPath("blocks/hero/hero.js"), true);
  assert.equal(isAllowedWriterPath("styles/styles.css"), true);
  assert.equal(isAllowedWriterPath("component-models.json"), true);
  assert.equal(isAllowedWriterPath("component-definition.json"), true);
  assert.equal(isAllowedWriterPath("component-filters.json"), true);
  assert.equal(isAllowedWriterPath("ui.apps/src/main/content/jcr_root/apps/site/components/hero/hero.html"), true);
  assert.equal(isAllowedWriterPath("core/src/main/java/site/components/HeroModel.java"), true);
  assert.equal(isAllowedWriterPath("scripts/scripts.js"), false);
  assert.equal(isAllowedWriterPath("package.json"), false);
  assert.equal(isAllowedWriterPath("../../etc/passwd"), false);
});

test("writeResult on a git repo commits exactly the planned files onto the worktree's real branch", async () => {
  const gitDir = mkdtempSync(join(tmpdir(), "blocksmith-writer-git-"));
  const scratchDir = mkdtempSync(join(tmpdir(), "blocksmith-writer-scratch-"));
  try {
    await execFileAsync("git", ["clone", "--local", FIXTURE_ROOT, gitDir]);
    const jobId = "job_writer_test1";
    const ws = await createJobWorkspace({ targetRoot: gitDir, scratchDir, jobId, blockName: "promo-banner", isGitRepo: true });

    mkdirSync(join(ws.dir, "blocks", "promo-banner"), { recursive: true });
    writeFileSync(join(ws.dir, "blocks", "promo-banner", "promo-banner.js"), "export default function decorate(block) {}\n");
    writeFileSync(join(ws.dir, "blocks", "promo-banner", "promo-banner.css"), ".promo-banner { display: block; }\n");

    const result = await writeResult({
      targetRoot: gitDir,
      workspace: ws,
      jobId,
      blockName: "promo-banner",
      filesToCreate: ["blocks/promo-banner/promo-banner.js", "blocks/promo-banner/promo-banner.css"],
      filesToModify: [],
    });

    assert.equal(result.mode, "git-commit");
    assert.equal(result.branchName, ws.branchName);
    assert.ok(result.commitSha);
    assert.deepEqual(result.filesWritten.sort(), ["blocks/promo-banner/promo-banner.css", "blocks/promo-banner/promo-banner.js"]);

    const { stdout: log } = await execFileAsync("git", ["log", "-1", "--pretty=%s"], { cwd: ws.dir });
    assert.match(log, /promo-banner/);

    const { stdout: showFiles } = await execFileAsync("git", ["show", "--stat", "--pretty=", "HEAD"], { cwd: ws.dir });
    assert.match(showFiles, /promo-banner\.js/);
    assert.match(showFiles, /promo-banner\.css/);

    // The main checkout (gitDir itself, not the worktree) should be unaffected — still on its original branch.
    const { stdout: mainBranch } = await execFileAsync("git", ["branch", "--show-current"], { cwd: gitDir });
    assert.notEqual(mainBranch.trim(), ws.branchName);

    await removeJobWorkspace(gitDir, ws);
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test("writeResult on a non-git folder copies files directly and backs up what it overwrites", async () => {
  const targetRoot = mkdtempSync(join(tmpdir(), "blocksmith-writer-nongit-"));
  const scratchDir = mkdtempSync(join(tmpdir(), "blocksmith-writer-scratch-"));
  try {
    mkdirSync(join(targetRoot, "blocks", "cards"), { recursive: true });
    const originalCardsJs = "export default function decorate(block) { /* original */ }\n";
    writeFileSync(join(targetRoot, "blocks", "cards", "cards.js"), originalCardsJs);

    const jobId = "job_writer_test2";
    const ws = await createJobWorkspace({ targetRoot, scratchDir, jobId, blockName: "cards", isGitRepo: false });

    // Simulate the Builder having modified cards.js and created a brand-new block in the isolated copy.
    writeFileSync(join(ws.dir, "blocks", "cards", "cards.js"), "export default function decorate(block) { /* modified */ }\n");
    mkdirSync(join(ws.dir, "blocks", "promo-banner"), { recursive: true });
    writeFileSync(join(ws.dir, "blocks", "promo-banner", "promo-banner.js"), "export default function decorate(block) {}\n");

    const result = await writeResult({
      targetRoot,
      workspace: ws,
      jobId,
      blockName: "promo-banner",
      filesToCreate: ["blocks/promo-banner/promo-banner.js"],
      filesToModify: ["blocks/cards/cards.js"],
    });

    assert.equal(result.mode, "direct-write");
    assert.ok(result.backupDir);
    assert.deepEqual(result.filesWritten.sort(), ["blocks/cards/cards.js", "blocks/promo-banner/promo-banner.js"]);

    // The real target folder now has the modified content...
    assert.match(readFileSync(join(targetRoot, "blocks", "cards", "cards.js"), "utf-8"), /modified/);
    assert.ok(existsSync(join(targetRoot, "blocks", "promo-banner", "promo-banner.js")));

    // ...and the original is preserved in the backup.
    assert.equal(readFileSync(join(result.backupDir!, "blocks", "cards", "cards.js"), "utf-8"), originalCardsJs);
    // The newly created file has nothing to back up.
    assert.equal(existsSync(join(result.backupDir!, "blocks", "promo-banner", "promo-banner.js")), false);

    await removeJobWorkspace(targetRoot, ws);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test("writeResult writes code-only output directly from a git worktree into the selected checkout", async () => {
  const targetRoot = mkdtempSync(join(tmpdir(), "blocksmith-writer-code-only-target-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "blocksmith-writer-code-only-worktree-"));
  const relativePath = "ui.apps/src/main/content/jcr_root/apps/wknd/components/subscribe-button/.content.xml";
  try {
    mkdirSync(join(workspaceDir, "ui.apps", "src", "main", "content", "jcr_root", "apps", "wknd", "components", "subscribe-button"), { recursive: true });
    writeFileSync(join(workspaceDir, relativePath), '<jcr:root sling:resourceSuperType="wknd/components/button" />');

    const result = await writeResult({
      targetRoot,
      workspace: { dir: workspaceDir, isGitWorktree: true, branchName: "blocksmith/subscribe-button-test" },
      jobId: "job_code_only",
      blockName: "subscribe-button",
      filesToCreate: [relativePath],
      filesToModify: [],
      writeDirectly: true,
    });

    assert.equal(result.mode, "direct-write");
    assert.equal(result.branchName, null);
    assert.ok(existsSync(join(targetRoot, relativePath)));
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("writeResult filters out any planned path outside the allowlist even if it exists in the built workspace", async () => {
  const targetRoot = mkdtempSync(join(tmpdir(), "blocksmith-writer-allowlist-"));
  const scratchDir = mkdtempSync(join(tmpdir(), "blocksmith-writer-scratch-"));
  try {
    mkdirSync(join(targetRoot, "scripts"), { recursive: true });
    writeFileSync(join(targetRoot, "scripts", "scripts.js"), "// original\n");

    const jobId = "job_writer_test3";
    const ws = await createJobWorkspace({ targetRoot, scratchDir, jobId, blockName: "x", isGitRepo: false });
    writeFileSync(join(ws.dir, "scripts", "scripts.js"), "// a rogue write attempt, should never land\n");
    mkdirSync(join(ws.dir, "blocks", "x"), { recursive: true });
    writeFileSync(join(ws.dir, "blocks", "x", "x.js"), "export default function decorate() {}\n");

    const result = await writeResult({
      targetRoot,
      workspace: ws,
      jobId,
      blockName: "x",
      filesToCreate: ["blocks/x/x.js", "scripts/scripts.js"],
      filesToModify: [],
    });

    assert.deepEqual(result.filesWritten, ["blocks/x/x.js"]);
    assert.equal(readFileSync(join(targetRoot, "scripts", "scripts.js"), "utf-8"), "// original\n");

    await removeJobWorkspace(targetRoot, ws);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test("writeResult throws a clear error when none of the planned files actually exist in the workspace", async () => {
  const targetRoot = mkdtempSync(join(tmpdir(), "blocksmith-writer-empty-"));
  const scratchDir = mkdtempSync(join(tmpdir(), "blocksmith-writer-scratch-"));
  try {
    const jobId = "job_writer_test4";
    const ws = await createJobWorkspace({ targetRoot, scratchDir, jobId, blockName: "ghost", isGitRepo: false });

    await assert.rejects(
      () =>
        writeResult({
          targetRoot,
          workspace: ws,
          jobId,
          blockName: "ghost",
          filesToCreate: ["blocks/ghost/ghost.js"],
          filesToModify: [],
        }),
      /did the Builder actually run/,
    );

    await removeJobWorkspace(targetRoot, ws);
  } finally {
    rmSync(targetRoot, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  }
});
