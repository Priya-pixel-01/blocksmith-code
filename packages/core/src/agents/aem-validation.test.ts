import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAEMComponentSpec } from "./aem-validation.js";
import type { AemComponentSpec } from "../schemas/aem-spec.js";
import type { RepoProfile } from "../schemas/repo-profile.js";

const profile = {
  modules: [
    { id: "ui.apps", path: "ui.apps", kind: "application", buildFiles: [], sourceRoots: [], testRoots: [], dependencies: [] },
    { id: "ui.frontend", path: "ui.frontend", kind: "frontend", buildFiles: [], sourceRoots: [], testRoots: [], dependencies: [] },
    { id: "core", path: "core", kind: "backend", buildFiles: [], sourceRoots: [], testRoots: [], dependencies: [] },
  ],
  aemComponents: [],
} as unknown as RepoProfile;

function spec(paths: Partial<AemComponentSpec["implementation"]>): AemComponentSpec {
  return {
    projectType: "aem",
    name: "subscribe-button",
    purpose: "Subscription call to action.",
    requirements: [],
    reuseDecision: { decision: "create", targetComponent: null, rationale: "new", confidence: 1, evidence: [], gaps: [] },
    requiredModules: [],
    requiredFiles: [],
    dependencies: [],
    implementation: {
      htl: [], dialog: [], resourceType: "wknd/components/subscribe-button", slingModel: null,
      frontend: [], backend: [], conventions: [], ...paths,
    },
    acceptanceCriteria: [],
    openQuestions: [],
  };
}

test("AEM spec validation rejects aggregate and structure source paths", () => {
  const result = validateAEMComponentSpec(profile, spec({
    htl: ["all/src/main/content/jcr_root/apps/wknd/components/subscribe-button/subscribe-button.html"],
    frontend: ["ui.apps.structure/src/main/webpack/components/subscribe-button/subscribe-button.scss"],
  }));

  assert.equal(result.isValid, false);
  assert.ok(result.errors.some((error) => error.includes("all/")));
  assert.ok(result.errors.some((error) => error.includes("ui.apps.structure/")));
});

test("AEM spec validation accepts concrete module-owned component paths", () => {
  const result = validateAEMComponentSpec(profile, spec({
    htl: ["ui.apps/src/main/content/jcr_root/apps/wknd/components/subscribe-button/subscribe-button.html"],
    dialog: ["ui.apps/src/main/content/jcr_root/apps/wknd/components/subscribe-button/_cq_dialog/.content.xml"],
    frontend: ["ui.frontend/src/main/webpack/components/subscribe-button/subscribe-button.scss"],
  }));

  assert.deepEqual(result, { isValid: true, errors: [] });
});

test("AEM spec validation accepts relative artifact names resolved by the planner", () => {
  const result = validateAEMComponentSpec(profile, spec({
    htl: ["subscribe-button.html"],
    dialog: [".content.xml"],
    frontend: ["subscribe-button.scss"],
  }));

  assert.deepEqual(result, { isValid: true, errors: [] });
});

test("AEM spec validation rejects the shared Granite clientlib template as a local artifact", () => {
  const result = validateAEMComponentSpec(profile, spec({
    htl: ["clientlib.html"],
    dialog: ["_cq_dialog/clientlib.html"],
  }));
  assert.equal(result.isValid, false);
  assert.equal(result.errors.filter((error) => error.includes("shared Granite clientlib.html template")).length, 2);
});

test("without a frontend module, accept component clientlibs and reject uncompiled or misplaced assets", () => {
  const localProfile = { ...profile, modules: profile.modules.filter((module) => module.kind !== "frontend") };
  const root = "ui.apps/src/main/content/jcr_root/apps/wknd/components/subscribe-button";
  assert.equal(validateAEMComponentSpec(localProfile, spec({ frontend: [`${root}/clientlib/css/style.css`, `${root}/clientlib/js/script.js`] })).isValid, true);
  for (const path of [`${root}/style.css`, `${root}/clientlib/css/style.scss`, "ui.frontend/src/main/webpack/style.css"]) {
    assert.equal(validateAEMComponentSpec(localProfile, spec({ frontend: [path] })).isValid, false, path);
  }
});
