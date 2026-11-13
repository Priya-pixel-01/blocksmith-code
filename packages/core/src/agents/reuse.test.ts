import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeReuse } from "./reuse.js";
import { createBlockTools } from "../tools/blocks.js";
import { buildRepoProfile } from "./cartographer/index.js";
import type { RepoProfile } from "../schemas/repo-profile.js";
import type { BlockSpec } from "../schemas/block-spec.js";
import type { ModelRouter, AgentLoopResult } from "../llm/router.js";
import type { ReuseDecision } from "../schemas/plan.js";

const FIXTURE_ROOT = resolve(import.meta.dirname, "../../../../fixtures/aem-boilerplate-xwalk");

test("fixture is present", () => {
  assert.ok(existsSync(FIXTURE_ROOT), `Expected fixture at ${FIXTURE_ROOT} — run: git clone https://github.com/adobe-rnd/aem-boilerplate-xwalk.git fixtures/aem-boilerplate-xwalk`);
});

// These exercise the tool executors directly against the real fixture — no LLM involved — since
// that's the part that must be exactly right regardless of which model calls it: the model's
// *judgment* (create vs extend vs variant) can only be verified with a live OpenRouter call,
// which this sandbox's egress policy blocks (same restriction as figma.com/openrouter.ai
// elsewhere in this project).
// Tool executors are called directly here (bypassing the AI SDK's tool-calling runtime, which
// normally supplies a full ToolExecutionOptions), so each is cast to a simple callable rather
// than constructing a real options object — see the identical pattern in tools/sandbox.test.ts.

test("list_blocks tool reflects the real repo profile's block summaries", async () => {
  const profile = await buildRepoProfile(FIXTURE_ROOT);
  const { list_blocks } = createBlockTools(FIXTURE_ROOT, profile);
  const execute = list_blocks.execute as unknown as () => Promise<{ blocks: Array<{ name: string }> }>;

  const result = await execute();
  const names = result.blocks.map((b) => b.name).sort();
  assert.deepEqual(names, ["cards", "columns", "footer", "fragment", "header", "hero"]);
});

test("read_block tool returns the real source files for an existing block", async () => {
  const profile = await buildRepoProfile(FIXTURE_ROOT);
  const { read_block } = createBlockTools(FIXTURE_ROOT, profile);
  const execute = read_block.execute as unknown as (input: { name: string }) => Promise<{ name: string; files: Record<string, string> } | { error: string }>;

  const result = await execute({ name: "cards" });
  assert.ok("files" in result);
  assert.equal(result.name, "cards");
  assert.ok(result.files["cards.js"]?.includes("moveInstrumentation"));
  assert.ok(result.files["cards.css"]?.includes("grid-template-columns"));
});

test("read_block tool returns a clear error for a block name that doesn't exist", async () => {
  const profile = await buildRepoProfile(FIXTURE_ROOT);
  const { read_block } = createBlockTools(FIXTURE_ROOT, profile);
  const execute = read_block.execute as unknown as (input: { name: string }) => Promise<{ name: string; files: Record<string, string> } | { error: string }>;

  const result = await execute({ name: "does-not-exist" });
  assert.ok("error" in result);
  assert.match(result.error, /No block named "does-not-exist"/);
});

const FAKE_BLOCK_SPEC: BlockSpec = {
  blockNameCandidate: "card-grid",
  intent: "A grid of image+text cards.",
  ueFields: [],
  domContract: "A `<ul>` of `<li>` cards.",
  responsive: [],
  variants: [],
  tokenMapping: [],
  a11y: [],
  openQuestions: [],
};

const FAKE_DECISION: ReuseDecision = {
  decision: "variant",
  targetBlock: "cards",
  rationale: "The repo's existing cards block already matches this DOM shape.",
  confidence: 0.9,
};

test("analyzeReuse runs the tool loop then extracts a structured decision from the router", async () => {
  const profile: RepoProfile = await buildRepoProfile(FIXTURE_ROOT);

  const loopCalls: unknown[] = [];
  const structuredCalls: unknown[] = [];

  const stubRouter = {
    runAgentLoop: async (args: unknown) => {
      loopCalls.push(args);
      return {
        text: "I checked the cards block and it's a close match.",
        messages: [{ role: "assistant", content: "I checked the cards block and it's a close match." }],
        stepCount: 2,
        costUsd: 0.002,
      } satisfies AgentLoopResult;
    },
    generateStructured: async (args: unknown) => {
      structuredCalls.push(args);
      return { object: FAKE_DECISION, costUsd: 0.001, promptTokens: 10, completionTokens: 5 };
    },
  } as unknown as ModelRouter;

  const { reuseDecision: decision, costUsd } = await analyzeReuse({ root: FIXTURE_ROOT, repoProfile: profile, blockSpec: FAKE_BLOCK_SPEC, router: stubRouter });

  assert.deepEqual(decision, FAKE_DECISION);
  assert.equal(costUsd, 0.003, "costUsd should sum the tool loop's cost and the structured-extraction call's cost");
  assert.equal(loopCalls.length, 1);
  assert.equal(structuredCalls.length, 1);

  const loopArgs = loopCalls[0] as { role: string; prompt: string; tools: Record<string, unknown> };
  assert.equal(loopArgs.role, "reuse");
  assert.ok(loopArgs.prompt.includes("card-grid"));
  assert.ok(loopArgs.tools.list_blocks);
  assert.ok(loopArgs.tools.read_block);
});

test("analyzeReuse's costUsd is null when neither router call reports usage data", async () => {
  const profile: RepoProfile = await buildRepoProfile(FIXTURE_ROOT);

  const stubRouter = {
    runAgentLoop: async () =>
      ({
        text: "Checked.",
        messages: [{ role: "assistant", content: "Checked." }],
        stepCount: 1,
        costUsd: null,
      }) satisfies AgentLoopResult,
    generateStructured: async () => ({ object: FAKE_DECISION, costUsd: null, promptTokens: null, completionTokens: null }),
  } as unknown as ModelRouter;

  const { costUsd } = await analyzeReuse({ root: FIXTURE_ROOT, repoProfile: profile, blockSpec: FAKE_BLOCK_SPEC, router: stubRouter });
  assert.equal(costUsd, null);
});
