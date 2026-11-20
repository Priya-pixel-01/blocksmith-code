import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { computeFilePlan, createPlan } from "./planner.js";
import { buildRepoProfile } from "./cartographer/index.js";
import { PlanSchema } from "../schemas/plan.js";
import type { BlockSpec } from "../schemas/block-spec.js";
import type { ReuseDecision } from "../schemas/plan.js";
import type { ModelRouter } from "../llm/router.js";

const FIXTURE_ROOT = resolve(import.meta.dirname, "../../../../fixtures/aem-boilerplate-xwalk");

test("fixture is present", () => {
  assert.ok(existsSync(FIXTURE_ROOT), `Expected fixture at ${FIXTURE_ROOT} — run: git clone https://github.com/adobe-rnd/aem-boilerplate-xwalk.git fixtures/aem-boilerplate-xwalk`);
});

const BASE_BLOCK_SPEC: BlockSpec = {
  blockNameCandidate: "testimonial-carousel",
  intent: "A rotating set of customer testimonials.",
  ueFields: [{ name: "quote", component: "richtext", valueType: "string", label: "Quote", required: true, options: null }],
  domContract: "A `<ul>` of `<li>` testimonial cards.",
  responsive: [],
  variants: [],
  tokenMapping: [
    { designValue: "#3b63fb", mappedToken: "--link-color", isNew: false },
    { designValue: "#ff00aa", mappedToken: null, isNew: true },
  ],
  a11y: [],
  openQuestions: ["Should the carousel auto-rotate, or only advance on user interaction?"],
};

test("computeFilePlan for a new block in a fragments-shaped repo creates only the block's own files, no root file edits", async () => {
  const profile = await buildRepoProfile(FIXTURE_ROOT);
  const reuseDecision: ReuseDecision = { decision: "create", targetBlock: null, rationale: "No analogue exists.", confidence: 0.9 };

  const { filesToCreate, filesToModify } = computeFilePlan(profile, BASE_BLOCK_SPEC, reuseDecision);

  assert.deepEqual(
    filesToCreate.sort(),
    ["blocks/testimonial-carousel/_testimonial-carousel.json", "blocks/testimonial-carousel/testimonial-carousel.css", "blocks/testimonial-carousel/testimonial-carousel.js"].sort(),
  );
  assert.deepEqual(filesToModify, []);
});

test("computeFilePlan for a variant of an existing UE-wired block modifies its files, including its _<name>.json", async () => {
  const profile = await buildRepoProfile(FIXTURE_ROOT);
  const reuseDecision: ReuseDecision = { decision: "variant", targetBlock: "cards", rationale: "cards already matches this shape.", confidence: 0.85 };

  const { filesToCreate, filesToModify } = computeFilePlan(profile, BASE_BLOCK_SPEC, reuseDecision);

  assert.deepEqual(filesToCreate, []);
  assert.deepEqual(filesToModify.sort(), ["blocks/cards/_cards.json", "blocks/cards/cards.css", "blocks/cards/cards.js"].sort());
});

test("computeFilePlan for extending a block with no UE json does not invent one", async () => {
  const profile = await buildRepoProfile(FIXTURE_ROOT);
  // header has no _header.json in the fixture (confirmed in the Cartographer's own tests).
  const reuseDecision: ReuseDecision = { decision: "extend", targetBlock: "header", rationale: "header needs a new capability.", confidence: 0.7 };

  const { filesToModify } = computeFilePlan(profile, BASE_BLOCK_SPEC, reuseDecision);

  assert.deepEqual(filesToModify.sort(), ["blocks/header/header.css", "blocks/header/header.js"].sort());
});

test("computeFilePlan throws if reuseDecision is extend/variant with no targetBlock", async () => {
  const profile = await buildRepoProfile(FIXTURE_ROOT);
  const reuseDecision: ReuseDecision = { decision: "extend", targetBlock: null, rationale: "x", confidence: 0.5 };
  assert.throws(() => computeFilePlan(profile, BASE_BLOCK_SPEC, reuseDecision), /has no targetBlock/);
});

test("computeFilePlan asks unknown projects to use their selected folder without assuming EDS paths", async () => {
  const detectedProfile = await buildRepoProfile(FIXTURE_ROOT);
  const profile = { ...detectedProfile, projectType: "unknown" as const };
  const reuseDecision: ReuseDecision = { decision: "create", targetBlock: null, rationale: "Unsupported framework.", confidence: 1 };
  const result = computeFilePlan(profile, { ...BASE_BLOCK_SPEC, targetDirectory: "src/components" }, reuseDecision);

  assert.equal(result.adjustedBlockName, "testimonial-carousel");
  assert.deepEqual(result.filesToCreate, [
    "src/components/testimonial-carousel/testimonial-carousel.html",
    "src/components/testimonial-carousel/testimonial-carousel.css",
    "src/components/testimonial-carousel/testimonial-carousel.js",
  ]);
  assert.deepEqual(result.filesToModify, []);
});

test("computeFilePlan rejects unknown projects without a user-selected destination", async () => {
  const detectedProfile = await buildRepoProfile(FIXTURE_ROOT);
  const profile = { ...detectedProfile, projectType: "unknown" as const };
  const reuseDecision: ReuseDecision = { decision: "create", targetBlock: null, rationale: "Unsupported framework.", confidence: 1 };

  assert.throws(
    () => computeFilePlan(profile, BASE_BLOCK_SPEC, reuseDecision),
    /destination folder must be selected/,
  );
});

test("createPlan merges deterministic file plan and token reuse with the model's narrative into a schema-valid Plan", async () => {
  const profile = await buildRepoProfile(FIXTURE_ROOT);
  const reuseDecision: ReuseDecision = { decision: "create", targetBlock: null, rationale: "No analogue exists.", confidence: 0.9 };

  let capturedPrompt = "";
  const stubRouter = {
    generateStructured: async (args: { prompt: string }) => {
      capturedPrompt = args.prompt;
      return {
        object: {
          summary: "Builds a new testimonial-carousel block.",
          verificationCriteria: ["Renders correctly at all breakpoints", "Lint passes"],
          risks: ["Carousel controls must be keyboard-accessible"],
          additionalOpenQuestions: [],
          newTokenNames: [{ designValue: "#ff00aa", proposedName: "--testimonial-carousel-accent", rationale: "No existing token is this shade." }],
        },
        costUsd: 0.001,
        promptTokens: 20,
        completionTokens: 10,
      };
    },
  } as unknown as ModelRouter;

  const { plan, costUsd } = await createPlan({ jobId: "job_test", repoProfile: profile, blockSpec: BASE_BLOCK_SPEC, reuseDecision, router: stubRouter });

  assert.equal(costUsd, 0.001);

  const parsed = PlanSchema.safeParse(plan);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.format(), null, 2));

  assert.equal(plan.blockName, "testimonial-carousel");
  assert.deepEqual(plan.reuseDecision, reuseDecision);
  assert.deepEqual(plan.tokensReused, ["--link-color"]);
  assert.deepEqual(plan.tokensNew, [{ name: "--testimonial-carousel-accent", value: "#ff00aa", rationale: "No existing token is this shade." }]);
  assert.ok(plan.filesToCreate.includes("blocks/testimonial-carousel/_testimonial-carousel.json"));
  assert.ok(plan.openQuestions.includes("Should the carousel auto-rotate, or only advance on user interaction?"));
  assert.ok(capturedPrompt.includes("#ff00aa"));
});
