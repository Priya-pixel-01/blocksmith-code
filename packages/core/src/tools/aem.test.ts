import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateAemArtifacts } from "./aem.js";
import type { RepoProfile } from "../schemas/repo-profile.js";

const profile = {
  aemComponents: [{
    id: "ui.apps/src/main/components/hero",
    name: "hero",
    path: "ui.apps/src/main/components/hero",
    resourceType: "site/components/hero",
    dialogPaths: ["ui.apps/src/main/components/hero/_cq_dialog/.content.xml"],
    htlPaths: ["ui.apps/src/main/components/hero/hero.html"],
    clientlibPaths: [],
    configurationPaths: [],
    artifacts: [],
    frontendAssets: [],
    backendTypes: [],
    variants: [],
    dependencies: [],
    tests: [],
  }],
} as unknown as RepoProfile;

test("validateAemArtifacts reports missing and malformed AEM files", () => {
  const root = mkdtempSync(join(tmpdir(), "blocksmith-aem-tools-"));
  try {
    mkdirSync(join(root, "ui.apps/src/main/components/hero/_cq_dialog"), { recursive: true });
    writeFileSync(join(root, "ui.apps/src/main/components/hero/_cq_dialog/.content.xml"), "not xml");
    const issues = validateAemArtifacts(root, profile);
    assert.ok(issues.some((issue) => issue.message.includes("does not begin")));
    assert.ok(issues.some((issue) => issue.path.endsWith("hero.html")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
