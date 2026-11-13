import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { RepoProfileSchema } from "../../schemas/repo-profile.js";
import { buildRepoProfile } from "./index.js";

const FIXTURE_ROOT = resolve(import.meta.dirname, "../../../../../fixtures/aem-boilerplate-xwalk");
const AEM_FIXTURE_ROOT = resolve(import.meta.dirname, "../../../../../fixtures/aem-project",);


test("buildRepoProfile produces a schema-valid profile with no router (fully deterministic)", async () => {
  const profile = await buildRepoProfile(FIXTURE_ROOT);
  const parsed = RepoProfileSchema.safeParse(profile);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.format(), null, 2));

  assert.equal(profile.projectType, "eds");
  assert.deepEqual(profile.modules, []);
  assert.deepEqual(profile.aemComponents, []);
  assert.deepEqual(profile.aemArtifacts, []);
  assert.equal(profile.blocks.length, 6);
  assert.ok(profile.digestMarkdown.includes("Project type: **EDS**"));
  assert.ok(profile.digestMarkdown.includes("## Blocks (6)"));
  assert.ok(profile.digestMarkdown.includes("cards"));
  assert.ok(profile.digestMarkdown.includes("Universal Editor: yes"));
});

test("buildRepoProfile identifies an AEM project", async () => {
  const profile = await buildRepoProfile(AEM_FIXTURE_ROOT);

  assert.equal(profile.projectType, "aem");

  assert.ok(!profile.digestMarkdown.includes("Project type: **EDS**"));
  assert.ok(profile.digestMarkdown.includes("Project type: **AEM**"));
});

test("buildRepoProfile's cacheKey is stable across two runs against the same commit", async () => {
  const a = await buildRepoProfile(FIXTURE_ROOT);
  const b = await buildRepoProfile(FIXTURE_ROOT);
  assert.equal(a.cacheKey, b.cacheKey);
});
