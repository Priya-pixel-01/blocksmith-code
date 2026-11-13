import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getDb, __resetDbForTests } from "../db/client.js";
import { WorkspaceRepository } from "../db/repository.js";
import { analyzeAemReuse } from "../agents/aem-reuse.js";
import { ensureWorkspaceProfile, refreshAemWorkspaceProfile } from "./setup.js";

const FIXTURE_ROOT = resolve(import.meta.dirname, "../../../../fixtures/aem-boilerplate-xwalk");

test("fixture is present", () => {
  assert.ok(existsSync(FIXTURE_ROOT), `Expected fixture at ${FIXTURE_ROOT}`);
});

test("ensureWorkspaceProfile builds on first call and reuses the cached profile on a second call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blocksmith-workspace-"));
  try {
    __resetDbForTests();
    const workspaces = new WorkspaceRepository(getDb(join(dir, "blocksmith.sqlite")));

    const first = await ensureWorkspaceProfile({ workspaceId: "ws1", rootPath: FIXTURE_ROOT, workspaces });
    assert.equal(first.blocks.length, 6);

    // Second call within the same cache key should return the identical cached object, not rebuild.
    const stored = workspaces.get("ws1")!;
    const second = await ensureWorkspaceProfile({ workspaceId: "ws1", rootPath: FIXTURE_ROOT, workspaces });
    assert.equal(second.generatedAt, stored.repoProfile!.generatedAt, "should not have rebuilt — generatedAt should be unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureWorkspaceProfile rebuilds when force is set even if the cache key is unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blocksmith-workspace-"));
  try {
    __resetDbForTests();
    const workspaces = new WorkspaceRepository(getDb(join(dir, "blocksmith.sqlite")));

    const first = await ensureWorkspaceProfile({ workspaceId: "ws1", rootPath: FIXTURE_ROOT, workspaces });
    const second = await ensureWorkspaceProfile({ workspaceId: "ws1", rootPath: FIXTURE_ROOT, workspaces, force: true });
    assert.notEqual(first.generatedAt, second.generatedAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refreshAemWorkspaceProfile retains a component generated on an isolated worktree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blocksmith-aem-refresh-"));
  const targetRoot = join(dir, "target");
  const workspaceDir = join(dir, "worktree");
  const componentPath = join(workspaceDir, "ui.apps", "src", "main", "content", "jcr_root", "apps", "wknd", "components", "subscribe-button");
  try {
    __resetDbForTests();
    mkdirSync(join(targetRoot, "ui.apps"), { recursive: true });
    writeFileSync(join(targetRoot, "pom.xml"), "<project><artifactId>wknd</artifactId></project>");
    writeFileSync(join(targetRoot, "ui.apps", "pom.xml"), "<project><artifactId>ui.apps</artifactId></project>");
    mkdirSync(componentPath, { recursive: true });
    writeFileSync(join(workspaceDir, "pom.xml"), "<project><artifactId>wknd</artifactId></project>");
    writeFileSync(join(workspaceDir, "ui.apps", "pom.xml"), "<project><artifactId>ui.apps</artifactId></project>");
    writeFileSync(join(componentPath, ".content.xml"), '<jcr:root sling:resourceSuperType="wknd/components/button" />');
    writeFileSync(join(componentPath, "subscribe-button.html"), "<button>Subscribe</button>");

    const workspaces = new WorkspaceRepository(getDb(join(dir, "blocksmith.sqlite")));
    await ensureWorkspaceProfile({ workspaceId: "ws1", rootPath: targetRoot, workspaces });
    refreshAemWorkspaceProfile({ workspaceId: "ws1", workspaceDir, workspaces });

    const cached = await ensureWorkspaceProfile({ workspaceId: "ws1", rootPath: targetRoot, workspaces });
    assert.equal(cached.aemComponents.some((component) => component.name === "subscribe-button"), true);
    assert.notEqual(analyzeAemReuse(cached.aemComponents, { name: "subscribe-button" }).decision, "create");
  } finally {
    __resetDbForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureWorkspaceProfile throws a clear error for a nonexistent path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blocksmith-workspace-"));
  try {
    __resetDbForTests();
    const workspaces = new WorkspaceRepository(getDb(join(dir, "blocksmith.sqlite")));
    await assert.rejects(
      () => ensureWorkspaceProfile({ workspaceId: "ws1", rootPath: join(dir, "does-not-exist"), workspaces }),
      /does not exist/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
