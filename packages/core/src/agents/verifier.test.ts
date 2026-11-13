import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, cpSync, symlinkSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { verifyBlock } from "./verifier.js";
import { buildRepoProfile } from "./cartographer/index.js";
import type { Plan, ReuseDecision } from "../schemas/plan.js";
import type { SourceArtifact } from "../schemas/source.js";
import type { ModelRouter } from "../llm/router.js";

const FIXTURE_ROOT = resolve(import.meta.dirname, "../../../../fixtures/aem-boilerplate-xwalk");

test("fixture is present", () => {
  assert.ok(existsSync(FIXTURE_ROOT), `Expected fixture at ${FIXTURE_ROOT}`);
});

const REUSE_DECISION: ReuseDecision = { decision: "variant", targetBlock: "cards", rationale: "test", confidence: 0.9 };

function makeCardsPlan(): Plan {
  return {
    jobId: "job_verify_test",
    blockName: "cards",
    summary: "test plan",
    reuseDecision: REUSE_DECISION,
    filesToCreate: [],
    filesToModify: ["blocks/cards/cards.js", "blocks/cards/cards.css"],
    domContract: "A <ul> of <li> cards.",
    ueFields: [
      { name: "image", component: "reference", valueType: "string", label: "Image", required: false, options: null },
      { name: "text", component: "richtext", valueType: "string", label: "Text", required: false, options: null },
    ],
    tokensReused: [],
    tokensNew: [],
    verificationCriteria: [],
    risks: [],
    openQuestions: [],
  };
}

async function makeSourceArtifact(dir: string): Promise<SourceArtifact> {
  const imagePath = join(dir, "design.png");
  await sharp({ create: { width: 300, height: 200, channels: 3, background: { r: 80, g: 120, b: 200 } } }).png().toFile(imagePath);
  return { kind: "image", originGeoRef: imagePath, textContent: null, images: [imagePath], structured: null };
}

const PASSING_VISION_CRITIQUE = { pass: true, summary: "Looks correct.", issues: [] };

function stubRouter(critique: unknown, onCall?: () => void): ModelRouter {
  return {
    generateStructured: async () => {
      onCall?.();
      return { object: critique, costUsd: 0.001, promptTokens: 10, completionTokens: 5 };
    },
  } as unknown as ModelRouter;
}

test("verifyBlock passes for a clean render, clean lint, clean axe, and a passing vision critique", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blocksmith-verify-"));
  try {
    const repoProfile = await buildRepoProfile(FIXTURE_ROOT);
    const artifact = await makeSourceArtifact(dir);
    const plan = makeCardsPlan();

    const { verdict, costUsd } = await verifyBlock({
      workspaceDir: FIXTURE_ROOT,
      repoProfile,
      plan,
      sourceArtifact: artifact,
      router: stubRouter(PASSING_VISION_CRITIQUE),
      outDir: join(dir, "screenshots"),
      iteration: 1,
    });

    assert.equal(verdict.pass, true, JSON.stringify(verdict, null, 2));
    assert.equal(verdict.lintPassed, true);
    assert.equal(verdict.axeViolationCount, 0);
    assert.equal(verdict.screenshotPaths.length, 3);
    assert.equal(verdict.iteration, 1);
    assert.equal(costUsd, 0.001);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyBlock fails overall when lint fails, even if the vision critique says pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blocksmith-verify-broken-"));
  try {
    for (const entry of ["blocks", "styles", "scripts", "package.json", ".eslintrc.js", ".stylelintrc.json"]) {
      cpSync(join(FIXTURE_ROOT, entry), join(dir, entry), { recursive: true });
    }
    symlinkSync(join(FIXTURE_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
    appendFileSync(join(dir, "blocks", "cards", "cards.js"), "\nconst thisVariableIsNeverUsed = 42;\n");

    const repoProfile = await buildRepoProfile(dir);
    const artifact = await makeSourceArtifact(dir);
    const plan = makeCardsPlan();

    const { verdict } = await verifyBlock({
      workspaceDir: dir,
      repoProfile,
      plan,
      sourceArtifact: artifact,
      router: stubRouter(PASSING_VISION_CRITIQUE),
      outDir: join(dir, "screenshots"),
      iteration: 1,
    });

    assert.equal(verdict.pass, false);
    assert.equal(verdict.lintPassed, false);
    assert.ok(verdict.issues.some((i) => i.severity === "blocker" && i.area === "style"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// aem.js's loadBlock() catches a failed module import internally and still marks the block
// "loaded" regardless (confirmed in verify/render.test.ts) — so a missing block module doesn't
// exercise the "never finished rendering" path. The only real way a block stays stuck at
// data-block-status="loading" is a decorate() that genuinely never resolves, so that's what this
// constructs — at the cost of actually waiting out the real 15s render timeout in session.ts.
test("verifyBlock reports a failure without calling the vision model when decorate() never resolves", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blocksmith-verify-hang-"));
  try {
    for (const entry of ["blocks", "styles", "scripts", "package.json", ".eslintrc.js", ".stylelintrc.json"]) {
      cpSync(join(FIXTURE_ROOT, entry), join(dir, entry), { recursive: true });
    }
    symlinkSync(join(FIXTURE_ROOT, "node_modules"), join(dir, "node_modules"), "dir");
    mkdirSync(join(dir, "blocks", "hanging-block"), { recursive: true });
    writeFileSync(join(dir, "blocks", "hanging-block", "hanging-block.js"), "export default function decorate() { return new Promise(() => {}); }\n");
    writeFileSync(join(dir, "blocks", "hanging-block", "hanging-block.css"), "");

    const repoProfile = await buildRepoProfile(dir);
    const artifact = await makeSourceArtifact(dir);
    const plan = { ...makeCardsPlan(), blockName: "hanging-block" };

    let visionCalled = false;
    const { verdict, costUsd } = await verifyBlock({
      workspaceDir: dir,
      repoProfile,
      plan,
      sourceArtifact: artifact,
      router: stubRouter(PASSING_VISION_CRITIQUE, () => {
        visionCalled = true;
      }),
      outDir: join(dir, "screenshots"),
      iteration: 2,
    });

    assert.equal(visionCalled, false, "should not waste a vision-model call on a block that never rendered");
    assert.equal(verdict.pass, false);
    assert.equal(verdict.iteration, 2);
    assert.ok(verdict.issues.some((i) => i.severity === "blocker"));
    assert.equal(costUsd, null, "no LLM call was made, so there's no cost to report");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
