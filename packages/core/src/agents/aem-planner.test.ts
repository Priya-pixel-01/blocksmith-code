import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { buildRepoProfile } from "./cartographer/index.js";
import { computeAEMFilePlan, validateAEMFilePlan } from "./aem-planner.js";
import { validateAEMImplementationPlan } from "./aem-validation.js";
import type { AemPlan } from "../schemas/aem-plan.js";
import type { AemComponentSpec } from "../schemas/aem-spec.js";
import type { AemReuseDecision } from "../schemas/aem-profile.js";

const FIXTURE_ROOT = resolve(import.meta.dirname, "../../../../fixtures/aem-boilerplate-xwalk");
const REUSE: AemReuseDecision = {
  decision: "create",
  targetComponent: null,
  rationale: "No matching AEM component exists.",
  confidence: 0.9,
  evidence: [],
  gaps: ["component does not exist"],
};
const SPEC: AemComponentSpec = {
  projectType: "aem",
  name: "login-button",
  purpose: "Authentication entry point.",
  requirements: ["Render a semantic login link."],
  reuseDecision: REUSE,
  requiredModules: [],
  requiredFiles: [],
  dependencies: [],
  implementation: {
    htl: [],
    dialog: [".content.xml"],
    resourceType: "site/components/login-button",
    slingModel: null,
    frontend: ["login-button.scss", "login-button.js"],
    backend: [],
    conventions: [],
  },
  acceptanceCriteria: ["Keyboard accessible"],
  openQuestions: [],
};

test("without a frontend module, plan browser assets and clientlib manifests inside the component", async () => {
  const original = await buildRepoProfile(FIXTURE_ROOT);
  const profile = { ...original, modules: original.modules.filter((module) => module.kind !== "frontend") };
  const plan = computeAEMFilePlan(profile, SPEC);
  const root = "ui.apps/src/main/content/jcr_root/apps/site/components/login-button/clientlib";
  for (const file of [".content.xml", "css.txt", "js.txt", "css/login-button.css", "js/login-button.js"]) {
    assert.ok(plan.filesToCreate.includes(`${root}/${file}`), file);
  }
  assert.ok(plan.filesToCreate.every((path) => !path.startsWith("ui.frontend/") && !path.endsWith(".scss")));
  assert.deepEqual(validateAEMImplementationPlan(profile, SPEC, { filePlan: plan } as AemPlan), { isValid: true, errors: [] });
});

test("CSS-only local clientlibs do not plan a JavaScript manifest", async () => {
  const original = await buildRepoProfile(FIXTURE_ROOT);
  const profile = { ...original, modules: original.modules.filter((module) => module.kind !== "frontend") };
  const plan = computeAEMFilePlan(profile, { ...SPEC, implementation: { ...SPEC.implementation, frontend: ["login-button.css"] } });
  assert.ok(plan.filesToCreate.some((path) => path.endsWith("/clientlib/css.txt")));
  assert.ok(plan.filesToCreate.every((path) => !path.endsWith("/js.txt")));
});

test("computeAEMFilePlan produces deterministic AEM module paths", async () => {
  const profile = await buildRepoProfile(FIXTURE_ROOT);
  const first = computeAEMFilePlan(profile, SPEC);
  const second = computeAEMFilePlan(profile, SPEC);

  assert.deepEqual(first, second);
  assert.equal(first.targetModule, "ui.apps");
  assert.ok(first.filesToCreate.some((path) => path.startsWith("ui.apps/")));
  assert.ok(first.filesToCreate.some((path) => path.startsWith("ui.frontend/")));
  assert.ok(first.filesToCreate.every((path) => !path.startsWith("blocks/")));
});

test("validateAEMFilePlan rejects EDS block paths", async () => {
  const profile = await buildRepoProfile(FIXTURE_ROOT);
  assert.throws(
    () => validateAEMFilePlan(profile, SPEC, {
      targetModule: "ui.apps",
      filesToCreate: ["blocks/login-button/login-button.js"],
      filesToModify: [],
      filesToReuse: [],
      directoriesToCreate: ["blocks/login-button"],
    }),
    /cannot target EDS blocks/,
  );
});

test("computeAEMFilePlan relocates model paths into real AEM modules", async () => {
  const profile = await buildRepoProfile(FIXTURE_ROOT);
  const spec = {
    ...SPEC,
    name: "subscribe-button",
    implementation: {
      ...SPEC.implementation,
      htl: ["all/src/main/content/jcr_root/apps/wknd/components/subscribe-button.html"],
      dialog: ["all/src/main/content/jcr_root/apps/wknd/components/button/_cq_dialog/.content.xml"],
      frontend: ["all/src/main/webpack/components/subscribe-button/subscribe-button.scss"],
    },
  };

  const plan = computeAEMFilePlan(profile, spec);

  assert.ok(plan.filesToCreate.some((path) => path.startsWith("ui.apps/") && path.endsWith("/components/subscribe-button/subscribe-button.html")));
  assert.ok(plan.filesToCreate.some((path) => path.startsWith("ui.apps/") && path.endsWith("/components/subscribe-button/_cq_dialog/.content.xml")));
  assert.ok(plan.filesToCreate.some((path) => path.startsWith("ui.frontend/") && path.endsWith("/components/subscribe-button/subscribe-button.scss")));
  assert.ok(plan.filesToCreate.every((path) => !path.startsWith("all/")));
  assert.ok(plan.filesToCreate.every((path) => !path.includes("/components/button/")));
});

test("computeAEMFilePlan strips module prefixes and trailing prose from model artifacts", async () => {
  const profile = await buildRepoProfile(FIXTURE_ROOT);
  const spec = {
    ...SPEC,
    name: "subscribe-button",
    implementation: {
      ...SPEC.implementation,
      htl: ["ui.apps.structure/src/main/content/jcr_root/apps/wknd/components/subscribe-button/subscribe-button.html Extend button template"],
      dialog: ["ui.apps.structure/src/main/content/jcr_root/apps/wknd/components/subscribe-button/_cq_dialog/.content.xml Add subscription fields"],
      frontend: [
        "all/src/main/webpack/components/subscribe-button/subscribe-button.scss as main stylesheet",
        "all/src/main/webpack/components/subscribe-button/_default.scss variant for standard styling",
      ],
    },
  };

  const plan = computeAEMFilePlan(profile, spec);

  assert.ok(plan.filesToCreate.some((path) => path.startsWith("ui.apps/") && path.endsWith("/components/subscribe-button/subscribe-button.html")));
  assert.ok(plan.filesToCreate.some((path) => path.startsWith("ui.apps/") && path.endsWith("/components/subscribe-button/_cq_dialog/.content.xml")));
  assert.ok(plan.filesToCreate.some((path) => path.startsWith("ui.frontend/") && path.endsWith("/components/subscribe-button/subscribe-button.scss")));
  assert.ok(plan.filesToCreate.some((path) => path.startsWith("ui.frontend/") && path.endsWith("/components/subscribe-button/_default.scss")));
  assert.ok(plan.filesToCreate.every((path) => !path.startsWith("all/") && !path.startsWith("ui.apps.structure/")));
});

test("computeAEMFilePlan ignores aggregate modules mislabeled as source modules", () => {
  const profile = {
    modules: [
      { id: "all", path: "all", kind: "frontend", buildFiles: [], sourceRoots: [], testRoots: [], dependencies: [] },
      { id: "ui.apps.structure", path: "ui.apps.structure", kind: "application", buildFiles: [], sourceRoots: [], testRoots: [], dependencies: [] },
      { id: "ui.apps", path: "ui.apps", kind: "application", buildFiles: [], sourceRoots: [], testRoots: [], dependencies: [] },
      { id: "ui.frontend", path: "ui.frontend", kind: "frontend", buildFiles: [], sourceRoots: [], testRoots: [], dependencies: [] },
      { id: "core", path: "core", kind: "backend", buildFiles: [], sourceRoots: [], testRoots: [], dependencies: [] },
    ],
    aemComponents: [],
  } as never;
  const plan = computeAEMFilePlan(profile, {
    ...SPEC,
    name: "subscribe",
    implementation: { ...SPEC.implementation, resourceType: "wknd/components/subscribe", htl: ["subscribe.html"], frontend: ["subscribe.scss"] },
  });

  assert.ok(plan.filesToCreate.every((path) => path.startsWith("ui.apps/") || path.startsWith("ui.frontend/")));
});

test("computeAEMFilePlan reuses exact matches without creating or modifying files", () => {
  const component = {
    id: "ui.apps/src/main/content/jcr_root/apps/wknd/components/subscribe-button",
    name: "subscribe-button",
    path: "ui.apps/src/main/content/jcr_root/apps/wknd/components/subscribe-button",
    resourceType: "wknd/components/subscribe-button",
    dialogPaths: [], htlPaths: [], clientlibPaths: [], configurationPaths: [],
    artifacts: ["ui.apps/src/main/content/jcr_root/apps/wknd/components/subscribe-button/.content.xml"],
    frontendAssets: [], backendTypes: [], variants: [], dependencies: [], tests: [],
  };
  const profile = {
    modules: [
      { id: "ui.apps", path: "ui.apps", kind: "application", buildFiles: [], sourceRoots: [], testRoots: [], dependencies: [] },
      { id: "ui.frontend", path: "ui.frontend", kind: "frontend", buildFiles: [], sourceRoots: [], testRoots: [], dependencies: [] },
      { id: "core", path: "core", kind: "backend", buildFiles: [], sourceRoots: [], testRoots: [], dependencies: [] },
    ],
    aemComponents: [component],
  } as never;
  const spec = { ...SPEC, name: "subscribe-button", implementation: { ...SPEC.implementation, htl: [], dialog: [], frontend: [], backend: [] } };
  const plan = computeAEMFilePlan(profile, spec, { decision: "reuse", targetComponent: component.id, rationale: "Exact match", confidence: 1, evidence: [component.path], gaps: [] });

  assert.deepEqual(plan.filesToCreate, []);
  assert.deepEqual(plan.filesToModify, []);
  assert.deepEqual(plan.filesToReuse, component.artifacts);
});

test("computeAEMFilePlan preserves Java package paths from Sling Model artifacts", () => {
  const profile = {
    modules: [
      { id: "ui.apps", path: "ui.apps", kind: "application", buildFiles: [], sourceRoots: [], testRoots: [], dependencies: [] },
      { id: "ui.frontend", path: "ui.frontend", kind: "frontend", buildFiles: [], sourceRoots: [], testRoots: [], dependencies: [] },
      { id: "core", path: "core", kind: "backend", buildFiles: [], sourceRoots: [], testRoots: [], dependencies: [] },
    ],
    aemComponents: [],
  } as never;
  const spec = {
    ...SPEC,
    implementation: {
      ...SPEC.implementation,
      backend: [
        "core/src/main/java/com/adobe/aem/guides/wknd/core/models/SubscribeButtonModel.java",
        "core/src/main/java/com/adobe/aem/guides/wknd/core/models/impl/SubscribeButtonModelImpl.java",
      ],
    },
  };
  const plan = computeAEMFilePlan(profile, spec);

  assert.ok(plan.filesToCreate.includes("core/src/main/java/com/adobe/aem/guides/wknd/core/models/SubscribeButtonModel.java"));
  assert.ok(plan.filesToCreate.includes("core/src/main/java/com/adobe/aem/guides/wknd/core/models/impl/SubscribeButtonModelImpl.java"));
});
