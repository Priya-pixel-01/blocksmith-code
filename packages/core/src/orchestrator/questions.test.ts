import { test } from "node:test";
import assert from "node:assert/strict";
import { applyAemImplementationMode, questionsForAemSpec, requiresAemImplementationMode } from "./questions.js";
import type { AemComponentSpec } from "../schemas/aem-spec.js";
import type { RepoProfile } from "../schemas/repo-profile.js";

const SPEC = {
  projectType: "aem",
  name: "subscribe-button",
  purpose: "Subscription CTA",
  requirements: ["Render a link"],
  reuseDecision: { decision: "create", targetComponent: null, rationale: "new", confidence: 1, evidence: [], gaps: [] },
  requiredModules: [],
  requiredFiles: [],
  dependencies: [],
  implementation: { htl: ["subscribe-button.html"], dialog: [".content.xml"], resourceType: "wknd/components/subscribe-button", slingModel: null, frontend: [], backend: [], conventions: [] },
  acceptanceCriteria: [],
  openQuestions: ["Should the link support internal and external destinations?", "What is the subscription endpoint?"],
} as AemComponentSpec;

const PROFILE = {
  modules: [{ id: "core", path: "core", kind: "backend" }],
  aemArtifacts: [{ kind: "java", path: "core/src/main/java/com/adobe/aem/guides/wknd/core/models/Button.java" }],
} as unknown as RepoProfile;

test("questionsForAemSpec creates MCQ and text questions before planning", () => {
  const questions = questionsForAemSpec(SPEC);
  assert.equal(questions[0]?.kind, "single_choice");
  assert.deepEqual(questions[0]?.options.map((option) => option.value), ["internal", "external", "both"]);
  assert.equal(questions[1]?.kind, "text");
});

test("component, icon, and inheritance ambiguities get actionable choices", () => {
  const questions = questionsForAemSpec({
    ...SPEC,
    openQuestions: [
      "Should this be a new component or style variant?",
      "How should the arrow icon be implemented: SVG, icon font, or image asset?",
      "Should this inherit from subscribe-button or remain independent?",
    ],
  });
  assert.deepEqual(questions.map((question) => question.options.map((option) => option.value)), [
    ["new_component", "variant", "extend"],
    ["svg", "icon_font", "image_asset"],
    ["inherit", "independent"],
  ]);
});

test("properties mode removes Sling Model and Java artifacts", () => {
  const updated = applyAemImplementationMode({
    ...SPEC,
    implementation: { ...SPEC.implementation, slingModel: "models.SubscribeButtonModel", backend: ["core/src/main/java/models/SubscribeButtonModel.java"] },
  }, "properties", PROFILE);
  assert.equal(updated.implementation.slingModel, null);
  assert.deepEqual(updated.implementation.backend, []);
  assert.equal(updated.requiredModules.includes("core"), false);
});

test("Sling Model mode adds model and implementation files in the repository's models package", () => {
  const updated = applyAemImplementationMode(SPEC, "sling_model", PROFILE);
  assert.equal(updated.implementation.slingModel, "com.adobe.aem.guides.wknd.core.models.SubscribeButtonModel");
  assert.deepEqual(updated.implementation.backend, [
    "core/src/main/java/com/adobe/aem/guides/wknd/core/models/SubscribeButtonModel.java",
    "core/src/main/java/com/adobe/aem/guides/wknd/core/models/impl/SubscribeButtonModelImpl.java",
  ]);
});

test("implementation mode is required for AEM and mixed repositories only", () => {
  assert.equal(requiresAemImplementationMode("aem"), true);
  assert.equal(requiresAemImplementationMode("mixed"), true);
  assert.equal(requiresAemImplementationMode("eds"), false);
});