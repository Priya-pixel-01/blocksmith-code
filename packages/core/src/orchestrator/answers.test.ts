import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, __resetDbForTests } from "../db/client.js";
import { JobRepository, WorkspaceRepository } from "../db/repository.js";
import type { ModelRouter } from "../llm/router.js";
import { JobRunner } from "./runner.js";
import { agentTracePath } from "./agent-trace.js";
import type { RepoProfile } from "../schemas/repo-profile.js";
import type { AemComponentSpec } from "../schemas/aem-spec.js";

test("answerQuestions handles interpreter and planner clarification rounds before approval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blocksmith-aem-answers-"));
  __resetDbForTests();
  const db = getDb(join(dir, "blocksmith.sqlite"));
  const jobs = new JobRepository(db);
  const workspaces = new WorkspaceRepository(db);
  const workspaceId = "aem-answer-test";
  const profile = {
    workspaceRoot: dir,
    generatedAt: new Date().toISOString(),
    cacheKey: "test",
    isGitRepo: false,
    projectType: "aem",
    classification: { projectType: "aem", aemScore: 1, edsScore: 0, confidence: 1, confidenceBand: "high", evidence: [], reason: null, detectorVersion: "test" },
    modules: [
      { id: "ui.apps", path: "ui.apps", kind: "application", buildFiles: [], sourceRoots: [], testRoots: [], dependencies: [] },
      { id: "ui.frontend", path: "ui.frontend", kind: "frontend", buildFiles: [], sourceRoots: [], testRoots: [], dependencies: [] },
      { id: "core", path: "core", kind: "backend", buildFiles: [], sourceRoots: [], testRoots: [], dependencies: [] },
    ],
    aemArtifacts: [],
    aemComponents: [],
    relationships: [],
    missingComponents: [],
    authoringSurface: { hasUniversalEditor: false, modelShape: "none", fragmentsDir: null, buildJsonCommand: null, rootFiles: { componentDefinition: null, componentModels: null, componentFilters: null } },
    blocks: [],
    tokens: { colors: {}, fonts: {}, fontSizes: {}, spacing: {}, other: {}, breakpoints: [], tokensFile: "" },
    conventions: { jsLinter: null, cssLinter: null, lintCommand: null, quoteStyle: "double", semicolons: true, blocksHaveReadme: false },
    ueRegistry: null,
    digestMarkdown: "Synthetic AEM workspace for workflow test.",
  } as unknown as RepoProfile;
  workspaces.upsert({ id: workspaceId, rootPath: dir, isGitRepo: false });
  workspaces.saveRepoProfile(workspaceId, profile, "test");

  const spec = {
    projectType: "aem",
    name: "subscribe-button",
    purpose: "Subscription CTA",
    requirements: ["Render authored text and link"],
    reuseDecision: { decision: "create", targetComponent: null, rationale: "new", confidence: 1, evidence: [], gaps: ["component does not exist"] },
    requiredModules: [],
    requiredFiles: [],
    dependencies: [],
    implementation: { htl: ["subscribe-button.html"], dialog: [".content.xml"], resourceType: "wknd/components/subscribe-button", slingModel: null, frontend: [], backend: [], conventions: [] },
    acceptanceCriteria: [],
    openQuestions: ["Should the component support internal and external links?"],
  } as AemComponentSpec;
  const job = jobs.createJob({ batchId: "batch-answers", workspaceId, sourceKind: "image", sourceRef: "test.png", implementationMode: "properties" });
  jobs.setStatus(job.id, "awaiting_answers");
  jobs.update(job.id, {
    blockSpecJson: JSON.stringify(spec),
    openQuestionsJson: JSON.stringify([{ id: "link-types", prompt: spec.openQuestions[0], kind: "single_choice", options: [{ value: "internal", label: "Internal" }, { value: "external", label: "External" }, { value: "both", label: "Both" }], required: true }]),
  });

  let plannerCalls = 0;
  let holdPlanner = false;
  let plannerEntered = () => {};
  let plannerGate: Promise<void> = Promise.resolve();
  const router = {
    generateStructured: async () => {
      plannerCalls += 1;
      if (holdPlanner) {
        plannerEntered();
        await plannerGate;
        throw new Error("planner stage released");
      }
      return {
        object: {
          summary: plannerCalls === 1 ? "Subscribe button draft plan" : "Subscribe button final plan",
          verificationCriteria: [],
          risks: [],
          openQuestions: plannerCalls === 1 ? ["How should the arrow icon be implemented: SVG, icon font, or image asset?"] : [],
        },
        costUsd: 0,
      };
    },
  } as unknown as ModelRouter;
  const runner = new JobRunner({ jobs, workspaces, router, scratchDir: join(dir, "scratch") });

  try {
    await runner.answerQuestions(job.id, [{ questionId: "link-types", value: "both" }], "Keep the arrow decorative.");
    const draft = jobs.getJob(job.id)!;
    assert.equal(draft.status, "awaiting_answers");
    assert.equal(draft.plan?.summary, "Subscribe button draft plan");
    assert.equal(draft.openQuestions[0]?.kind, "single_choice");
    assert.deepEqual(draft.openQuestions[0]?.options.map((option) => option.value), ["svg", "icon_font", "image_asset"]);

    await runner.answerQuestions(job.id, [{ questionId: draft.openQuestions[0]!.id, value: "svg" }], "Use the existing WKND SVG convention.");
    const updated = jobs.getJob(job.id)!;
    assert.equal(updated.status, "awaiting_approval");
    assert.ok(updated.plan);
    assert.equal(updated.plan?.summary, "Subscribe button final plan");
    assert.equal(plannerCalls, 2);
    assert.equal(updated.implementationMode, "properties");
    assert.deepEqual((updated.blockSpec as AemComponentSpec).implementation.backend, []);
    assert.deepEqual((updated.blockSpec as AemComponentSpec).openQuestions, []);
    assert.match(updated.feedback ?? "", /internal and external links/);
    assert.match(updated.feedback ?? "", /Keep the arrow decorative/);
    assert.match(updated.feedback ?? "", /Use the existing WKND SVG convention/);
    const traceRecords = readFileSync(agentTracePath(join(dir, "scratch"), job.id), "utf-8").trim().split("\n").map((line) => JSON.parse(line) as { agent?: string; data?: { output?: { summary?: string } } });
    assert.ok(traceRecords.some((record) => record.agent === "aem-planner" && record.data?.output?.summary === "Subscribe button final plan"));
    assert.ok(traceRecords.some((record) => record.agent === "human"));

    jobs.setStatus(job.id, "awaiting_answers");
    jobs.update(job.id, {
      openQuestionsJson: JSON.stringify([{ id: "cancel-check", prompt: "Clarify the component", kind: "text", options: [], required: true }]),
    });
    let enterPlanner!: () => void;
    const plannerStarted = new Promise<void>((resolve) => { enterPlanner = resolve; });
    let releasePlanner!: () => void;
    plannerGate = new Promise<void>((resolve) => { releasePlanner = resolve; });
    plannerEntered = enterPlanner;
    holdPlanner = true;

    const answerRun = runner.answerQuestions(job.id, [{ questionId: "cancel-check", value: "Keep it concise" }]);
    await plannerStarted;
    let cancellationFinished = false;
    const cancellation = runner.cancelAndWait(job.id).then(() => { cancellationFinished = true; });
    await Promise.resolve();
    const drainedCurrentStage = !cancellationFinished;
    releasePlanner();
    await Promise.allSettled([answerRun, cancellation]);
    assert.equal(drainedCurrentStage, true, "deletion must wait for answer-driven planning to return");
    assert.equal(jobs.getJob(job.id)!.status, "rejected");
  } finally {
    __resetDbForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});