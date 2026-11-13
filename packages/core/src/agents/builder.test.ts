import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildBlock, createBuilderTools } from "./builder.js";
import { buildRepoProfile } from "./cartographer/index.js";
import { computeFilePlan } from "./planner.js";
import { createJobWorkspace, removeJobWorkspace } from "../workspace/isolate.js";
import type { BlockSpec } from "../schemas/block-spec.js";
import type { Plan, ReuseDecision } from "../schemas/plan.js";
import type { ModelRouter, AgentLoopResult } from "../llm/router.js";
import type { ToolSet } from "ai";

const FIXTURE_ROOT = resolve(import.meta.dirname, "../../../../fixtures/aem-boilerplate-xwalk");

test("fixture is present", () => {
  assert.ok(existsSync(FIXTURE_ROOT), `Expected fixture at ${FIXTURE_ROOT}`);
});

const NEW_BLOCK_JS = `import { moveInstrumentation } from '../../scripts/scripts.js';

export default function decorate(block) {
  const items = [...block.children];
  const ul = document.createElement('ul');
  items.forEach((row) => {
    const li = document.createElement('li');
    moveInstrumentation(row, li);
    li.append(...row.children);
    ul.append(li);
  });
  block.replaceChildren(ul);
}
`;

const NEW_BLOCK_CSS = `.testimonial-carousel > ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  gap: 24px;
}
`;

const NEW_BLOCK_UE_JSON = JSON.stringify(
  {
    definitions: [
      {
        title: "Testimonial Carousel",
        id: "testimonial-carousel",
        plugins: {
          xwalk: {
            page: {
              resourceType: "core/franklin/components/block/v1/block",
              template: { name: "Testimonial Carousel", model: "testimonial-carousel" },
            },
          },
        },
      },
    ],
    models: [
      {
        id: "testimonial-carousel",
        fields: [{ component: "richtext", valueType: "string", name: "quote", label: "Quote" }],
      },
    ],
    filters: [],
  },
  null,
  2,
);

const FAKE_BLOCK_SPEC: BlockSpec = {
  blockNameCandidate: "testimonial-carousel",
  intent: "A rotating set of customer testimonials.",
  ueFields: [{ name: "quote", component: "richtext", valueType: "string", label: "Quote", required: true, options: null }],
  domContract: "A <ul> of <li> testimonial cards.",
  responsive: [],
  variants: [],
  tokenMapping: [],
  a11y: [],
  openQuestions: [],
};

const FAKE_REUSE_DECISION: ReuseDecision = { decision: "create", targetBlock: null, rationale: "No analogue exists.", confidence: 0.9 };

async function makeScratchWorkspace() {
  const gitDir = mkdtempSync(join(tmpdir(), "blocksmith-builder-git-"));
  await promisify(execFile)("git", ["clone", "--local", FIXTURE_ROOT, gitDir]);
  // `git clone` never copies node_modules (it's gitignored, not tracked) — symlink the fixture's
  // real installed devDependencies in so the worktree isolate.ts creates below can, in turn,
  // symlink a working node_modules and `npm run lint` resolves the pinned eslint/stylelint.
  if (existsSync(join(FIXTURE_ROOT, "node_modules"))) {
    symlinkSync(join(FIXTURE_ROOT, "node_modules"), join(gitDir, "node_modules"), "dir");
  }
  const scratchDir = mkdtempSync(join(tmpdir(), "blocksmith-builder-scratch-"));
  const jobId = `job_${Math.random().toString(36).slice(2, 10)}`;
  const ws = await createJobWorkspace({ targetRoot: gitDir, scratchDir, jobId, blockName: "testimonial-carousel", isGitRepo: true });
  return {
    ws,
    async cleanup() {
      await removeJobWorkspace(gitDir, ws);
      rmSync(gitDir, { recursive: true, force: true });
      rmSync(scratchDir, { recursive: true, force: true });
    },
  };
}

/** Simulates a competent model: writes real files via the tools it's given, then reports done. */
function stubRouterThatWrites(filesToWrite: Record<string, string>): ModelRouter {
  return {
    runAgentLoop: async (args: { tools: ToolSet }) => {
      for (const [path, content] of Object.entries(filesToWrite)) {
        const execute = args.tools.fs_write!.execute as unknown as (input: { path: string; content: string }) => Promise<unknown>;
        const result = (await execute({ path, content })) as { error?: string };
        if (result?.error) throw new Error(`stub write to ${path} was rejected: ${result.error}`);
      }
      return { text: "Wrote the block.", messages: [], stepCount: 1, costUsd: 0.01 } satisfies AgentLoopResult;
    },
  } as unknown as ModelRouter;
}

test("buildBlock writes exactly the planned files and passes real lint", async () => {
  const { ws, cleanup } = await makeScratchWorkspace();
  try {
    const repoProfile = await buildRepoProfile(ws.dir);
    const { filesToCreate, filesToModify } = computeFilePlan(repoProfile, FAKE_BLOCK_SPEC, FAKE_REUSE_DECISION);
    const plan: Plan = {
      jobId: "job_test",
      blockName: "testimonial-carousel",
      summary: "test",
      reuseDecision: FAKE_REUSE_DECISION,
      filesToCreate,
      filesToModify,
      domContract: FAKE_BLOCK_SPEC.domContract,
      ueFields: FAKE_BLOCK_SPEC.ueFields,
      tokensReused: [],
      tokensNew: [],
      verificationCriteria: [],
      risks: [],
      openQuestions: [],
    };

    const router = stubRouterThatWrites({
      "blocks/testimonial-carousel/testimonial-carousel.js": NEW_BLOCK_JS,
      "blocks/testimonial-carousel/testimonial-carousel.css": NEW_BLOCK_CSS,
      "blocks/testimonial-carousel/_testimonial-carousel.json": NEW_BLOCK_UE_JSON,
    });

    const result = await buildBlock({ workspaceDir: ws.dir, repoProfile, blockSpec: FAKE_BLOCK_SPEC, plan, router });

    assert.deepEqual(result.filesWritten.sort(), plan.filesToCreate.sort());
    assert.deepEqual(result.filesMissing, []);
    assert.equal(result.lint.passed, true, result.lint.output);
    assert.equal(result.costUsd, 0.01);

    const written = readFileSync(join(ws.dir, "blocks/testimonial-carousel/testimonial-carousel.js"), "utf-8");
    assert.ok(written.includes("moveInstrumentation"));
  } finally {
    await cleanup();
  }
});

test("buildBlock does not write files outside the plan's allowlist, even if the model tries", async () => {
  const { ws, cleanup } = await makeScratchWorkspace();
  try {
    const repoProfile = await buildRepoProfile(ws.dir);
    const plan: Plan = {
      jobId: "job_test2",
      blockName: "testimonial-carousel",
      summary: "test",
      reuseDecision: FAKE_REUSE_DECISION,
      filesToCreate: ["blocks/testimonial-carousel/testimonial-carousel.js"],
      filesToModify: [],
      domContract: FAKE_BLOCK_SPEC.domContract,
      ueFields: [],
      tokensReused: [],
      tokensNew: [],
      verificationCriteria: [],
      risks: [],
      openQuestions: [],
    };

    const originalCards = readFileSync(join(ws.dir, "blocks/cards/cards.js"), "utf-8");

    const router = stubRouterThatWrites({
      "blocks/testimonial-carousel/testimonial-carousel.js": NEW_BLOCK_JS,
      "blocks/cards/cards.js": "// malicious overwrite attempt\n",
    });

    await assert.rejects(
      () => buildBlock({ workspaceDir: ws.dir, repoProfile, blockSpec: FAKE_BLOCK_SPEC, plan, router }),
      /not in this job's approved file list/,
    );

    // cards.js must be untouched — the attempted write to it should have been rejected before the malicious content landed.
    assert.equal(readFileSync(join(ws.dir, "blocks/cards/cards.js"), "utf-8"), originalCards);
  } finally {
    await cleanup();
  }
});

test("createBuilderTools' fs_patch also enforces the allowlist", async () => {
  const { ws, cleanup } = await makeScratchWorkspace();
  try {
    const repoProfile = await buildRepoProfile(ws.dir);
    const tools = createBuilderTools(ws.dir, repoProfile, ["blocks/hero/hero.css"]);
    const execute = tools.fs_patch.execute as unknown as (input: {
      path: string;
      oldString: string;
      newString: string;
      replaceAll: boolean;
    }) => Promise<{ error?: string }>;

    const result = await execute({ path: "blocks/cards/cards.css", oldString: "gap: 24px;", newString: "gap: 32px;", replaceAll: false });
    assert.match(result.error ?? "", /not in this job's approved file list/);
  } finally {
    await cleanup();
  }
});
