import { ReuseDecisionSchema, type ReuseDecision } from "../schemas/plan.js";
import type { BlockSpec } from "../schemas/block-spec.js";
import type { RepoProfile } from "../schemas/repo-profile.js";
import type { ModelRouter } from "../llm/router.js";
import { createBlockTools } from "../tools/blocks.js";

const SYSTEM_PROMPT = `You are the Reuse Analyst for Blocksmith. Given a proposed new EDS block and the \
target repo's existing blocks, decide whether to:
- "create": nothing in the repo does this — a genuinely new block is warranted.
- "extend": an existing block does something close, but needs new capability added to handle \
this case (e.g. a new field, a new code path in decorate()).
- "variant": an existing block already supports this shape structurally — it just needs a new \
block-option CSS class / variant, no JS changes.

You have two tools: list_blocks (a summary of every block already in the repo) and read_block \
(the actual source of one block's .js/.css/README, by name). ALWAYS read_block on any plausible \
candidate before deciding — never judge from the one-line summary alone. If you're genuinely \
unsure between two close options, say so and lower your confidence rather than picking one \
arbitrarily; low-confidence decisions get surfaced to a human, so it's safe to be honest here.

IMPORTANT: If the human's feedback explicitly requests creating a new block or says NOT to extend \
an existing one, respect that decision even if an existing block seems structurally similar.`;

/** Detects if user feedback explicitly requests creating a new block vs extending. */
function shouldForceCreateDecision(feedback: string | undefined): boolean {
  if (!feedback) return false;
  
  const createIndicators = [
    /\bcreate\s+(?:a\s+)?new\s+block\b/i,
    /\bnew\s+(?:standalone\s+)?block\b/i,
    /\bseparate\s+block\b/i,
    /\bdon'?t\s+extend\b/i,
    /\bshould\s+(?:be\s+)?(?:a\s+)?new\s+block\b/i,
    /\bnot\s+(?:extending|extend)\b/i,
    /\bindependent\s+block\b/i,
  ];
  
  return createIndicators.some(regex => regex.test(feedback));
}

export interface AnalyzeReuseOptions {
  root: string;
  repoProfile: RepoProfile;
  blockSpec: BlockSpec;
  router: ModelRouter;
  /** Human feedback from a rejected plan on a prior attempt, if this is a re-run. */
  feedback?: string;
}

export interface AnalyzeReuseResult {
  reuseDecision: ReuseDecision;
  costUsd: number | null;
}

export async function analyzeReuse({ root, repoProfile, blockSpec, router, feedback }: AnalyzeReuseOptions): Promise<AnalyzeReuseResult> {
  const tools = createBlockTools(root, repoProfile);

  const prompt = `Proposed block: "${blockSpec.blockNameCandidate}"
Intent: ${blockSpec.intent}
DOM contract: ${blockSpec.domContract}
Variants implied by the design: ${blockSpec.variants.join(", ") || "(none)"}
${feedback ? `\nHuman feedback on a previous attempt — take this into account:\n${feedback}\n` : ""}
Decide: create, extend, or variant? Use your tools to check the existing blocks before deciding.`;

  const loop = await router.runAgentLoop({
    role: "reuse",
    system: SYSTEM_PROMPT,
    prompt,
    tools,
    maxSteps: 8,
  });

  let result = await router.generateStructured({
    role: "reuse",
    schema: ReuseDecisionSchema,
    schemaName: "ReuseDecision",
    system: SYSTEM_PROMPT,
    messages: [
      { role: "user", content: prompt },
      ...loop.messages,
      { role: "user", content: "Based on everything above, give your final decision as JSON matching the schema." },
    ],
  });

  // If user's feedback explicitly requests creating a new block, override the decision
  if (shouldForceCreateDecision(feedback) && result.object.decision !== "create") {
    result.object = {
      decision: "create",
      targetBlock: null,
      rationale: `User feedback explicitly requested a new block: "${feedback}". Creating new block instead of ${result.object.decision}.`,
      confidence: 0.95,
    };
  }

  const costUsd = loop.costUsd == null && result.costUsd == null ? null : (loop.costUsd ?? 0) + (result.costUsd ?? 0);

  return { reuseDecision: result.object, costUsd };
}
