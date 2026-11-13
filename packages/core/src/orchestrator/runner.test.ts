import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { getDb, __resetDbForTests } from "../db/client.js";
import { JobRepository, WorkspaceRepository } from "../db/repository.js";
import { buildRepoProfile } from "../agents/cartographer/index.js";
import { JobRunner } from "./runner.js";
import type { ModelRouter, AgentLoopResult } from "../llm/router.js";
import type { BlockSpec } from "../schemas/block-spec.js";
import type { ReuseDecision } from "../schemas/plan.js";
import type { ToolSet } from "ai";

const execFileAsync = promisify(execFile);
const FIXTURE_ROOT = resolve(import.meta.dirname, "../../../../fixtures/aem-boilerplate-xwalk");

test("fixture is present", () => {
  assert.ok(existsSync(FIXTURE_ROOT), `Expected fixture at ${FIXTURE_ROOT}`);
});

const FAKE_BLOCK_SPEC: BlockSpec = {
  blockNameCandidate: "promo-banner",
  intent: "A full-width promotional banner with a headline and CTA.",
  ueFields: [{ name: "heading", component: "text", valueType: "string", label: "Heading", required: true, options: null }],
  domContract: "A single `<div>` with a heading and a link.",
  responsive: [],
  variants: [],
  tokenMapping: [],
  a11y: [],
  openQuestions: ["Should this be dismissible?"],
};

const FAKE_REUSE_DECISION: ReuseDecision = { decision: "create", targetBlock: null, rationale: "No analogue exists.", confidence: 0.8 };

function makeStubRouter(overrides?: { onGenerateStructured?: (args: any) => void }): ModelRouter {
  let structuredCallIndex = 0;
  return {
    runAgentLoop: async (): Promise<AgentLoopResult> => ({
      text: "explored",
      messages: [{ role: "assistant", content: "explored the existing blocks" }],
      stepCount: 1,
      costUsd: 0.001,
    }),
    generateStructured: async (args: any) => {
      overrides?.onGenerateStructured?.(args);
      structuredCallIndex += 1;
      // BlockSpec has an `intent` field, Plan narrative has `summary` — distinguish by schema shape via role.
      if (args.role === "interpreter") {
        return { object: FAKE_BLOCK_SPEC, costUsd: 0.001, promptTokens: 10, completionTokens: 5 };
      }
      if (args.role === "reuse") {
        return { object: FAKE_REUSE_DECISION, costUsd: 0.001, promptTokens: 10, completionTokens: 5 };
      }
      // planner
      return {
        object: {
          summary: `Plan attempt #${structuredCallIndex}`,
          verificationCriteria: ["Renders correctly"],
          risks: [],
          additionalOpenQuestions: [],
          newTokenNames: [],
        },
        costUsd: 0.001,
        promptTokens: 10,
        completionTokens: 5,
      };
    },
  } as unknown as ModelRouter;
}

async function setupFixture() {
  const dir = mkdtempSync(join(tmpdir(), "blocksmith-orchestrator-"));
  __resetDbForTests();
  const db = getDb(join(dir, "blocksmith.sqlite"));
  const jobs = new JobRepository(db);
  const workspaces = new WorkspaceRepository(db);

  const workspaceId = "ws_test";
  workspaces.upsert({ id: workspaceId, rootPath: FIXTURE_ROOT, isGitRepo: true });
  const profile = await buildRepoProfile(FIXTURE_ROOT);
  workspaces.saveRepoProfile(workspaceId, profile, profile.cacheKey);

  const imagePath = join(dir, "source.png");
  await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toFile(imagePath);

  return { dir, jobs, workspaces, workspaceId, imagePath };
}

test("runToApproval drives a job from created through awaiting_approval, persisting each intermediate result", async () => {
  const { dir, jobs, workspaces, workspaceId, imagePath } = await setupFixture();
  try {
    const job = jobs.createJob({ batchId: "batch_1", workspaceId, sourceKind: "image", sourceRef: imagePath });
    assert.equal(job.status, "created");

    const runner = new JobRunner({ jobs, workspaces, router: makeStubRouter(), scratchDir: join(dir, "scratch") });
    await runner.runToApproval(job.id);

    const updated = jobs.getJob(job.id)!;
    assert.equal(updated.status, "awaiting_approval");
    assert.ok(updated.sourceArtifact, "source artifact should be persisted");
    assert.ok(updated.blockSpec, "block spec should be persisted");
    assert.ok(updated.reuseDecision, "reuse decision should be persisted");
    assert.ok(updated.plan, "plan should be persisted");

    const events = jobs.listEvents(job.id);
    const statuses = events.filter((e) => e.type === "status").map((e) => e.data as { status: string });
    assert.deepEqual(
      statuses.map((s) => s.status),
      ["ingesting", "analyzing", "planning", "awaiting_approval"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancelAndWait drains the current stage, prevents later stages, and marks the job rejected", async () => {
  const { dir, jobs, workspaces, workspaceId, imagePath } = await setupFixture();
  try {
    const job = jobs.createJob({ batchId: "batch_cancel", workspaceId, sourceKind: "image", sourceRef: imagePath });
    let entered!: () => void;
    const stageEntered = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const stageGate = new Promise<void>((resolve) => { release = resolve; });
    const isAem = ["aem", "mixed"].includes(workspaces.get(workspaceId)!.repoProfile!.projectType);
    const router = {
      generateStructured: async () => {
        entered();
        await stageGate;
        return {
          object: isAem
            ? {
                projectType: "aem", name: "promo-banner", purpose: "A banner", requirements: [],
                requiredModules: [], requiredFiles: [], dependencies: [], acceptanceCriteria: [], openQuestions: [],
                implementation: { htl: [], dialog: [], resourceType: null, slingModel: null, frontend: [], backend: [], conventions: [] },
              }
            : FAKE_BLOCK_SPEC,
          costUsd: 0,
          promptTokens: 0,
          completionTokens: 0,
        };
      },
      runAgentLoop: async () => ({ text: "", messages: [], stepCount: 0, costUsd: 0 }),
    } as unknown as ModelRouter;
    const runner = new JobRunner({ jobs, workspaces, router, scratchDir: join(dir, "scratch") });

    const run = runner.runToApproval(job.id);
    await stageEntered;
    let cancellationFinished = false;
    const cancellation = runner.cancelAndWait(job.id).then(() => { cancellationFinished = true; });
    await Promise.resolve();
    assert.equal(cancellationFinished, false, "deletion must wait for the active stage to return");

    release();
    await cancellation;
    await assert.rejects(run, /cancelled/);
    assert.equal(jobs.getJob(job.id)!.status, "rejected");
    const statuses = jobs.listEvents(job.id).filter((event) => event.type === "status").map((event) => (event.data as { status: string }).status);
    assert.equal(statuses.includes("planning"), false, "canceled work must not advance to planning");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reject re-runs Interpreter/Reuse/Planner with accumulated feedback and returns to awaiting_approval", async () => {
  const { dir, jobs, workspaces, workspaceId, imagePath } = await setupFixture();
  try {
    const job = jobs.createJob({ batchId: "batch_1", workspaceId, sourceKind: "image", sourceRef: imagePath });

    const seenFeedback: (string | undefined)[] = [];
    const router = makeStubRouter({ onGenerateStructured: (args) => seenFeedback.push(args.prompt ?? JSON.stringify(args.messages)) });
    const runner = new JobRunner({ jobs, workspaces, router, scratchDir: join(dir, "scratch") });

    await runner.runToApproval(job.id);
    assert.equal(jobs.getJob(job.id)!.status, "awaiting_approval");

    await runner.reject(job.id, "Please make the CTA more prominent.");

    const updated = jobs.getJob(job.id)!;
    assert.equal(updated.status, "awaiting_approval");
    assert.equal(updated.iteration, 1);
    assert.equal(updated.feedback, "Please make the CTA more prominent.");

    const combined = seenFeedback.join("\n");
    assert.ok(combined.includes("Please make the CTA more prominent."), "feedback should reach the re-run agent calls");

    // second rejection accumulates rather than replacing
    await runner.reject(job.id, "Also add an image.");
    const twiceUpdated = jobs.getJob(job.id)!;
    assert.equal(twiceUpdated.iteration, 2);
    assert.ok(twiceUpdated.feedback!.includes("Please make the CTA more prominent."));
    assert.ok(twiceUpdated.feedback!.includes("Also add an image."));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reject throws if the job is not awaiting approval", async () => {
  const { dir, jobs, workspaces, workspaceId, imagePath } = await setupFixture();
  try {
    const job = jobs.createJob({ batchId: "batch_1", workspaceId, sourceKind: "image", sourceRef: imagePath });
    const runner = new JobRunner({ jobs, workspaces, router: makeStubRouter(), scratchDir: join(dir, "scratch") });
    await assert.rejects(() => runner.reject(job.id, "feedback"), /not awaiting approval/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runToApproval marks the job failed with a clear error if a stage throws", async () => {
  const { dir, jobs, workspaces, workspaceId, imagePath } = await setupFixture();
  try {
    const job = jobs.createJob({ batchId: "batch_1", workspaceId, sourceKind: "image", sourceRef: imagePath });
    const failingRouter = {
      runAgentLoop: async () => {
        throw new Error("simulated model failure");
      },
      generateStructured: async () => ({ object: FAKE_BLOCK_SPEC, costUsd: null, promptTokens: null, completionTokens: null }),
    } as unknown as ModelRouter;

    const runner = new JobRunner({ jobs, workspaces, router: failingRouter, scratchDir: join(dir, "scratch") });
    await assert.rejects(() => runner.runToApproval(job.id), /simulated model failure/);

    const updated = jobs.getJob(job.id)!;
    assert.equal(updated.status, "failed");
    assert.match(updated.errorMessage ?? "", /simulated model failure/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- approve() tests: these actually write into a repo, so they run against a scratch git clone
// of the fixture (never the fixture checkout itself, and never even the target of createJobWorkspace's
// worktree machinery) — the same isolation pattern used in builder.test.ts / writer.test.ts.

const NEW_BLOCK_JS = `export default function decorate(block) {
  const items = [...block.children];
  const wrapper = document.createElement('div');
  wrapper.className = 'promo-banner-inner';
  items.forEach((row) => wrapper.append(...row.children));
  block.replaceChildren(wrapper);
}
`;
const NEW_BLOCK_CSS = `.promo-banner-inner {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 24px;
}
`;
const NEW_BLOCK_UE_JSON = JSON.stringify(
  {
    definitions: [
      {
        title: "Promo Banner",
        id: "promo-banner",
        plugins: { xwalk: { page: { resourceType: "core/franklin/components/block/v1/block", template: { name: "Promo Banner", model: "promo-banner" } } } },
      },
    ],
    models: [{ id: "promo-banner", fields: [{ component: "text", valueType: "string", name: "heading", label: "Heading" }] }],
    filters: [],
  },
  null,
  2,
);

function makeFullPipelineRouter(finalVisionCritique: { pass: boolean; summary: string; issues: unknown[] }): ModelRouter {
  return {
    runAgentLoop: async (args: { role: string; tools?: ToolSet }) => {
      if (args.role === "builder" && args.tools) {
        const execute = args.tools.fs_write!.execute as unknown as (input: { path: string; content: string }) => Promise<{ error?: string }>;
        const files: Record<string, string> = {
          "blocks/promo-banner/promo-banner.js": NEW_BLOCK_JS,
          "blocks/promo-banner/promo-banner.css": NEW_BLOCK_CSS,
          "blocks/promo-banner/_promo-banner.json": NEW_BLOCK_UE_JSON,
        };
        for (const [path, content] of Object.entries(files)) {
          const result = await execute({ path, content });
          if (result?.error) throw new Error(`builder stub write to ${path} rejected: ${result.error}`);
        }
      }
      return { text: "done", messages: [], stepCount: 1, costUsd: 0.01 } satisfies AgentLoopResult;
    },
    generateStructured: async (args: { role: string }) => {
      if (args.role === "interpreter") return { object: FAKE_BLOCK_SPEC, costUsd: 0.001, promptTokens: 10, completionTokens: 5 };
      if (args.role === "reuse") return { object: FAKE_REUSE_DECISION, costUsd: 0.001, promptTokens: 10, completionTokens: 5 };
      if (args.role === "planner") {
        return {
          object: { summary: "Build promo-banner.", verificationCriteria: ["Renders correctly"], risks: [], additionalOpenQuestions: [], newTokenNames: [] },
          costUsd: 0.001,
          promptTokens: 10,
          completionTokens: 5,
        };
      }
      if (args.role === "verifier") return { object: finalVisionCritique, costUsd: 0.001, promptTokens: 10, completionTokens: 5 };
      throw new Error(`unexpected role in test stub: ${args.role}`);
    },
  } as unknown as ModelRouter;
}

async function setupGitFixture() {
  const dir = mkdtempSync(join(tmpdir(), "blocksmith-orchestrator-approve-"));
  const gitDir = join(dir, "repo");
  await execFileAsync("git", ["clone", "--local", FIXTURE_ROOT, gitDir]);
  if (existsSync(join(FIXTURE_ROOT, "node_modules"))) {
    symlinkSync(join(FIXTURE_ROOT, "node_modules"), join(gitDir, "node_modules"), "dir");
  }

  __resetDbForTests();
  const db = getDb(join(dir, "blocksmith.sqlite"));
  const jobs = new JobRepository(db);
  const workspaces = new WorkspaceRepository(db);

  const workspaceId = "ws_approve_test";
  workspaces.upsert({ id: workspaceId, rootPath: gitDir, isGitRepo: true });
  const profile = await buildRepoProfile(gitDir);
  workspaces.saveRepoProfile(workspaceId, profile, profile.cacheKey);

  const imagePath = join(dir, "source.png");
  await sharp({ create: { width: 200, height: 100, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toFile(imagePath);

  return { dir, gitDir, jobs, workspaces, workspaceId, imagePath };
}

test("approve builds, verifies (real lint/render/axe), and commits a passing block to a new branch", async () => {
  const { dir, gitDir, jobs, workspaces, workspaceId, imagePath } = await setupGitFixture();
  try {
    const job = jobs.createJob({ batchId: "batch_1", workspaceId, sourceKind: "image", sourceRef: imagePath });
    const router = makeFullPipelineRouter({ pass: true, summary: "Matches the design well.", issues: [] });
    const runner = new JobRunner({ jobs, workspaces, router, scratchDir: join(dir, "scratch") });

    await runner.runToApproval(job.id);
    assert.equal(jobs.getJob(job.id)!.status, "awaiting_approval");

    await runner.approve(job.id);

    const updated = jobs.getJob(job.id)!;
    assert.equal(updated.status, "done", updated.errorMessage ?? "");
    assert.equal(updated.iteration, 0); // iteration here tracks reject-rounds, not build/verify attempts

    const verdict = updated.verdict as { pass: boolean; lintPassed: boolean; axeViolationCount: number };
    assert.equal(verdict.pass, true);
    assert.equal(verdict.lintPassed, true);
    assert.equal(verdict.axeViolationCount, 0);

    const write = updated.writeResult as { mode: string; branchName: string; commitSha: string; filesWritten: string[] };
    assert.equal(write.mode, "git-commit");
    assert.ok(write.branchName.startsWith("blocksmith/promo-banner-"));
    assert.equal(updated.resultBranch, write.branchName);
    assert.ok(write.commitSha);

    const { stdout: showFiles } = await execFileAsync("git", ["show", "--stat", "--pretty=", write.commitSha], { cwd: gitDir });
    assert.match(showFiles, /promo-banner\.js/);
    assert.match(showFiles, /promo-banner\.css/);

    // Isolated build workspace should be cleaned up after a successful run.
    assert.ok(updated.workspaceDir);
    assert.equal(existsSync(updated.workspaceDir!), false);

    const events = jobs.listEvents(job.id);
    const statuses = events.filter((e) => e.type === "status").map((e) => (e.data as { status: string }).status);
    assert.deepEqual(statuses.slice(-4), ["building", "verifying", "writing", "done"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approve writes the last attempt and finishes 'done' (not 'failed') after exhausting the iteration budget on persistent verification failures", async () => {
  const { dir, jobs, workspaces, workspaceId, imagePath } = await setupGitFixture();
  try {
    const job = jobs.createJob({ batchId: "batch_1", workspaceId, sourceKind: "image", sourceRef: imagePath });
    const router = makeFullPipelineRouter({
      pass: false,
      summary: "The banner is missing the CTA link.",
      issues: [{ severity: "major", area: "content", description: "No call-to-action link rendered.", suggestedFix: "Add the CTA anchor." }],
    });
    const runner = new JobRunner({ jobs, workspaces, router, scratchDir: join(dir, "scratch") });

    await runner.runToApproval(job.id);
    await runner.approve(job.id);

    const updated = jobs.getJob(job.id)!;
    assert.equal(updated.status, "done", updated.errorMessage ?? "");

    const verdict = updated.verdict as { pass: boolean; iteration: number };
    assert.equal(verdict.pass, false);
    assert.equal(verdict.iteration, 3, "should have run the full 3-iteration budget");

    // Still wrote something — outstanding issues are surfaced via the persisted verdict, not hidden by discarding the work.
    const write = updated.writeResult as { mode: string; commitSha: string };
    assert.equal(write.mode, "git-commit");
    assert.ok(write.commitSha);

    const events = jobs.listEvents(job.id);
    const buildingCount = events.filter((e) => e.type === "status" && (e.data as { status: string }).status === "building").length;
    assert.equal(buildingCount, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- cost tracking ---

function makeCostTrackingRouter(costs: {
  interpret: number | null;
  reuseLoop: number | null;
  reuseStructured: number | null;
  plan: number | null;
}): ModelRouter {
  return {
    runAgentLoop: async (): Promise<AgentLoopResult> => ({
      text: "explored",
      messages: [{ role: "assistant", content: "explored the existing blocks" }],
      stepCount: 1,
      costUsd: costs.reuseLoop,
    }),
    generateStructured: async (args: { role: string }) => {
      if (args.role === "interpreter") return { object: FAKE_BLOCK_SPEC, costUsd: costs.interpret, promptTokens: null, completionTokens: null };
      if (args.role === "reuse") return { object: FAKE_REUSE_DECISION, costUsd: costs.reuseStructured, promptTokens: null, completionTokens: null };
      // planner
      return {
        object: { summary: "test plan", verificationCriteria: [], risks: [], additionalOpenQuestions: [], newTokenNames: [] },
        costUsd: costs.plan,
        promptTokens: null,
        completionTokens: null,
      };
    },
  } as unknown as ModelRouter;
}

test("runToApproval accumulates costUsd across interpret/reuse/plan (null calls contribute nothing), and reject() adds to the running total rather than resetting it", async () => {
  const { dir, jobs, workspaces, workspaceId, imagePath } = await setupFixture();
  try {
    const job = jobs.createJob({ batchId: "batch_1", workspaceId, sourceKind: "image", sourceRef: imagePath });

    // interpret: 0.002, reuse: null (loop) + 0.003 (structured) = 0.003, plan: null (contributes nothing)
    const firstRouter = makeCostTrackingRouter({ interpret: 0.002, reuseLoop: null, reuseStructured: 0.003, plan: null });
    const runner = new JobRunner({ jobs, workspaces, router: firstRouter, scratchDir: join(dir, "scratch") });

    await runner.runToApproval(job.id);
    assert.equal(jobs.getJob(job.id)!.costUsd, 0.005, "0.002 (interpret) + 0.003 (reuse) + 0 (plan reported no usage)");

    // A second run (via reject) with different, all-real costs must add to the existing total, not replace it.
    const secondRunner = new JobRunner({
      jobs,
      workspaces,
      router: makeCostTrackingRouter({ interpret: 0.001, reuseLoop: 0.001, reuseStructured: 0.001, plan: 0.001 }),
      scratchDir: join(dir, "scratch"),
    });
    await secondRunner.reject(job.id, "please revise");

    assert.equal(jobs.getJob(job.id)!.costUsd, 0.009, "0.005 already accumulated + 0.001*4 from the reject re-run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("approve() serializes build↔verify pipelines when buildConcurrency is 1 — two jobs approved together never overlap between their building and writing transitions", async () => {
  const { dir, gitDir, jobs, workspaces, workspaceId, imagePath } = await setupGitFixture();
  try {
    const jobA = jobs.createJob({ batchId: "batch_1", workspaceId, sourceKind: "image", sourceRef: imagePath });
    const jobB = jobs.createJob({ batchId: "batch_1", workspaceId, sourceKind: "image", sourceRef: imagePath });
    const router = makeFullPipelineRouter({ pass: true, summary: "Matches the design well.", issues: [] });
    const runner = new JobRunner({ jobs, workspaces, router, scratchDir: join(dir, "scratch"), buildConcurrency: 1 });

    await runner.runToApproval(jobA.id);
    await runner.runToApproval(jobB.id);

    await Promise.all([runner.approve(jobA.id), runner.approve(jobB.id)]);

    assert.equal(jobs.getJob(jobA.id)!.status, "done");
    assert.equal(jobs.getJob(jobB.id)!.status, "done");

    const windowFor = (jobId: string) => {
      const events = jobs.listEvents(jobId).filter((e) => e.type === "status");
      const buildingStart = events.find((e) => (e.data as { status: string }).status === "building")!.ts;
      const writingStart = events.find((e) => (e.data as { status: string }).status === "writing")!.ts;
      return { start: buildingStart, end: writingStart };
    };

    const [a, b] = [windowFor(jobA.id), windowFor(jobB.id)];
    const [first, second] = a.start < b.start ? [a, b] : [b, a];
    assert.ok(second.start >= first.end, `with buildConcurrency 1, the second job's building phase (${second.start}) must not start before the first job reached writing (${first.end})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
