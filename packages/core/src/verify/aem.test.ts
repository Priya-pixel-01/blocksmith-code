import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyAemComponent } from "./aem.js";
import type { AemPlan } from "../schemas/aem-plan.js";
import type { AemComponentSpec } from "../schemas/aem-spec.js";
import type { RepoProfile } from "../schemas/repo-profile.js";

const spec: AemComponentSpec = {
  projectType: "aem",
  name: "login-button",
  purpose: "Login entry point",
  requirements: [],
  reuseDecision: { decision: "create", targetComponent: null, rationale: "new", confidence: 1, evidence: [], gaps: [] },
  requiredModules: [],
  requiredFiles: [],
  dependencies: [],
  implementation: { htl: [], dialog: [], resourceType: "site/components/login-button", slingModel: null, frontend: [], backend: [], conventions: [] },
  acceptanceCriteria: [],
  openQuestions: [],
};
const profile = {
  modules: [{ id: "ui.apps", path: "ui.apps", kind: "application", buildFiles: [], sourceRoots: [], testRoots: [], dependencies: [] }],
  conventions: { lintCommand: null },
} as unknown as RepoProfile;

function plan(filesToCreate: string[]): AemPlan {
  return {
    projectType: "aem", jobId: "job", componentName: "login-button", blockName: "login-button", filesToCreate, filesToModify: [], domContract: "", ueFields: [], tokensReused: [], tokensNew: [], summary: "", componentSpec: spec, reuseDecision: spec.reuseDecision, filePlan: { targetModule: "ui.apps", filesToCreate, filesToModify: [], filesToReuse: [], directoriesToCreate: [] }, dependencies: [], verificationCriteria: [], risks: [], openQuestions: [],
  };
}

test("verifyAemComponent validates generated HTL and XML and reports no browser runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "blocksmith-aem-verify-"));
  try {
    const componentRoot = "ui.apps/src/main/content/jcr_root/apps/site/components/login-button";
    mkdirSync(join(root, componentRoot), { recursive: true });
    writeFileSync(join(root, componentRoot, ".content.xml"), "<jcr:root sling:resourceType=\"site/components/login-button\" />");
    writeFileSync(join(root, componentRoot, "login-button.html"), "<a href=\"${properties.link}\">${properties.text}</a>");
    const report = await verifyAemComponent({ workspaceDir: root, repoProfile: profile, componentSpec: spec, plan: plan([`${componentRoot}/.content.xml`, `${componentRoot}/login-button.html`]) });
    assert.equal(report.pass, true);
    assert.equal(report.renderAvailable, false);
    assert.equal(report.accessibilityChecked, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyAemComponent reports missing planned files", async () => {
  const root = mkdtempSync(join(tmpdir(), "blocksmith-aem-verify-missing-"));
  try {
    const report = await verifyAemComponent({ workspaceDir: root, repoProfile: profile, componentSpec: spec, plan: plan(["ui.apps/missing.html"]) });
    assert.equal(report.pass, false);
    assert.ok(report.issues.some((issue) => issue.area === "structure"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});