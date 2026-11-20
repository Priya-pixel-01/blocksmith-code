import { z } from "zod";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PlanSchema, type Plan, type ReuseDecision } from "../schemas/plan.js";
import type { BlockSpec } from "../schemas/block-spec.js";
import type { RepoProfile } from "../schemas/repo-profile.js";
import type { ModelRouter } from "../llm/router.js";
import { validateUEFields } from "../schemas/field-validation.js";
import { normalizeGenericDestination } from "../orchestrator/generic-project.js";

/**
 * Only the genuinely interpretive parts of a plan go through the model: a readable summary,
 * verification criteria, risk callouts, and names for any brand-new design tokens. Which files
 * get touched is computed deterministically from the repo's actual authoring surface (see
 * computeFilePlan) — that's a fact, not a judgment call, and grounding it in code rather than a
 * model's guess is what makes the fragment-glob discovery from the Repo Cartographer (new blocks
 * need only their own _<name>.json) actually reliable in the plan a human reviews.
 */
const PlanNarrativeSchema = z.object({
  summary: z.string().describe("Markdown. What will be built and why, for a human reviewing this plan before any code is written."),
  verificationCriteria: z.array(z.string()),
  risks: z.array(z.string()),
  additionalOpenQuestions: z.array(z.string()).describe("Anything ambiguous about the reuse decision or plan itself — in addition to, not replacing, the design's own open questions."),
  newTokenNames: z.array(
    z.object({
      designValue: z.string().describe("Must match one of the isNew token mappings given in the prompt, verbatim."),
      proposedName: z.string().describe("A CSS custom property name following the repo's existing naming convention, e.g. '--carousel-arrow-color'."),
      rationale: z.string(),
    }),
  ),
});

export interface CreatePlanOptions {
  jobId: string;
  repoProfile: RepoProfile;
  blockSpec: BlockSpec;
  reuseDecision: ReuseDecision;
  router: ModelRouter;
  /** Human feedback from a rejected plan on a prior attempt, if this is a re-run. */
  feedback?: string;
}

export interface CreatePlanResult {
  plan: Plan;
  costUsd: number | null;
}

export async function createPlan({ jobId, repoProfile, blockSpec, reuseDecision, router, feedback }: CreatePlanOptions): Promise<CreatePlanResult> {
  const { filesToCreate, filesToModify, adjustedBlockName } = computeFilePlan(repoProfile, blockSpec, reuseDecision);

  const newTokens = blockSpec.tokenMapping.filter((t) => t.isNew);
  const reusedTokens = [...new Set(blockSpec.tokenMapping.filter((t) => !t.isNew && t.mappedToken).map((t) => t.mappedToken!))];

  const prompt = buildPrompt(repoProfile, blockSpec, reuseDecision, filesToCreate, filesToModify, newTokens, feedback);

  const result = await router.generateStructured({
    role: "planner",
    schema: PlanNarrativeSchema,
    schemaName: "PlanNarrative",
    system:
      (repoProfile.projectType === "unknown"
        ? "You are planning a standalone, framework-neutral HTML/CSS/JavaScript component in a user-selected folder of an unsupported project. Do not claim it is integrated into the application."
        : "You are the Planner for Blocksmith. You write the plan a human reviews and approves before any code is written for a new or modified Adobe Edge Delivery Services block.") +
      " Be concrete and specific — this is what the human uses to decide whether to proceed, not marketing copy. Flag real risks rather than omitting them.\n\n" +
      "CRITICAL: If human feedback is present, it represents explicit rejection of the previous approach. " +
      "Acknowledge the feedback explicitly in your summary, explain how you are addressing it, and " +
      "reconsider whether the proposed reuse decision still aligns with the human's feedback. " +
      "If the feedback asks for a different approach (e.g., 'create instead of extend'), prioritize that over " +
      "repeating the previous decision.",
    prompt,
  });

  const tokensNew = newTokens.map((t) => {
    const named = result.object.newTokenNames.find((n) => n.designValue === t.designValue);
    return {
      name: named?.proposedName ?? `--${adjustedBlockName}-token`,
      value: t.designValue,
      rationale: named?.rationale ?? "No existing token matched this value.",
    };
  });

  // ENFORCE: Validate UE fields for orphan collapsible fields before plan is finalized
  const fieldValidation = validateUEFields(blockSpec.ueFields);
  if (!fieldValidation.isValid) {
    const errorList = fieldValidation.errors
      .filter(e => e.severity === "error")
      .map(e => `  • ${e.fieldName}: ${e.error}`)
      .join("\n");
    
    throw new Error(
      `Plan validation failed: UE fields violate xwalk rules:\n${errorList}\n\n` +
      `This indicates a bug in the Interpreter. The Interpreter should have caught this before creating the BlockSpec.`
    );
  }

  const plan: Plan = {
    jobId,
    blockName: adjustedBlockName,
    summary: result.object.summary,
    reuseDecision,
    filesToCreate,
    filesToModify,
    domContract: blockSpec.domContract,
    ueFields: blockSpec.ueFields,
    tokensReused: reusedTokens,
    tokensNew,
    verificationCriteria: result.object.verificationCriteria,
    risks: result.object.risks,
    openQuestions: [...new Set([...blockSpec.openQuestions, ...result.object.additionalOpenQuestions])],
  };

  return { plan: PlanSchema.parse(plan), costUsd: result.costUsd };
}

/**
 * Determines exactly which files the Builder will touch, grounded in the repo's real Universal
 * Editor authoring shape rather than a generic assumption:
 *  - "create" in a fragments-shaped repo needs only a new blocks/<name>/_<name>.json — it's
 *    picked up automatically by the existing glob merge in models/_component-*.json.
 *  - "create" in a monolithic repo must instead directly modify the three root component-*.json
 *    files, since there's no glob to pick up a new fragment.
 *  - "extend"/"variant" touches the target block's existing files, plus its _<name>.json only if
 *    it already has one (adding UE fields to a block that has none is itself a bigger change that
 *    should show up as a risk, not a silent file-plan detail).
 */
export function computeFilePlan(
  repoProfile: RepoProfile,
  blockSpec: BlockSpec,
  reuseDecision: ReuseDecision,
): { filesToCreate: string[]; filesToModify: string[]; adjustedBlockName: string } {
  if (repoProfile.projectType === "unknown") {
    if (reuseDecision.decision !== "create") {
      throw new Error("Unsupported project structures require a new standalone component; reuse and variant planning are unavailable.");
    }
    if (blockSpec.targetDirectory === undefined || blockSpec.targetDirectory === null) {
      throw new Error("A destination folder must be selected before planning files for an unsupported project structure.");
    }

    const destination = normalizeGenericDestination(blockSpec.targetDirectory);
    const baseName = blockSpec.blockNameCandidate.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!baseName) throw new Error("The generated component name is not a valid folder name.");

    let name = baseName;
    let counter = 2;
    const componentDirectory = () => [destination, name].filter(Boolean).join("/");
    while (existsSync(join(repoProfile.workspaceRoot, ...componentDirectory().split("/")))) {
      name = `${baseName}-${counter}`;
      counter += 1;
    }

    const directory = componentDirectory();
    const filePrefix = directory ? `${directory}/` : "";
    return {
      filesToCreate: [`${filePrefix}${name}.html`, `${filePrefix}${name}.css`, `${filePrefix}${name}.js`],
      filesToModify: [],
      adjustedBlockName: name,
    };
  }

  const { authoringSurface, conventions } = repoProfile;

  if (reuseDecision.decision === "create") {
    let name = blockSpec.blockNameCandidate;
    
    // Check if a block with this name already exists; if so, generate a unique name
    const existingBlockNames = new Set(repoProfile.blocks.map((b) => b.name));
    if (existingBlockNames.has(name)) {
      // Try appending numbers: -2, -3, -4, etc.
      let counter = 2;
      while (existingBlockNames.has(`${name}-${counter}`)) {
        counter++;
      }
      name = `${name}-${counter}`;
    }

    const filesToCreate = [`blocks/${name}/${name}.js`, `blocks/${name}/${name}.css`];
    if (conventions.blocksHaveReadme) filesToCreate.push(`blocks/${name}/README.md`);

    const filesToModify: string[] = [];
    if (authoringSurface.hasUniversalEditor) {
      if (authoringSurface.modelShape === "fragments") {
        filesToCreate.push(`blocks/${name}/_${name}.json`);
      } else {
        for (const file of Object.values(authoringSurface.rootFiles)) {
          if (file) filesToModify.push(file);
        }
      }
    }
    return { filesToCreate, filesToModify, adjustedBlockName: name };
  }

  // "extend" or "variant"
  const target = reuseDecision.targetBlock;
  if (!target) {
    throw new Error(`reuseDecision is "${reuseDecision.decision}" but has no targetBlock`);
  }
  const filesToModify = [`blocks/${target}/${target}.js`, `blocks/${target}/${target}.css`];
  const targetInfo = repoProfile.blocks.find((b) => b.name === target);
  if (targetInfo?.hasUeJson) {
    filesToModify.push(`blocks/${target}/_${target}.json`);
  }
  return { filesToCreate: [], filesToModify, adjustedBlockName: target };
}

function buildPrompt(
  repoProfile: RepoProfile,
  blockSpec: BlockSpec,
  reuseDecision: ReuseDecision,
  filesToCreate: string[],
  filesToModify: string[],
  newTokens: BlockSpec["tokenMapping"],
  feedback?: string,
): string {
  return `## Target repo
${repoProfile.digestMarkdown}
${feedback ? `\n## HUMAN FEEDBACK FROM REJECTED PLAN — THIS IS MANDATORY TO ADDRESS\n${feedback}\n\nYour summary MUST explicitly acknowledge this feedback and explain how your revised plan addresses it. If the feedback requests a different approach, prioritize it over the previous reuse decision.\n` : ""}

## Design intent
${blockSpec.intent}

## Previous reuse decision (provided for context; you may adjust based on human feedback)
Decision: ${reuseDecision.decision}${reuseDecision.targetBlock ? ` (target: ${reuseDecision.targetBlock})` : ""}
Rationale: ${reuseDecision.rationale}
Confidence: ${reuseDecision.confidence}

## Files this will touch (already determined from the repo's real authoring shape)
Create: ${filesToCreate.join(", ") || "(none)"}
Modify: ${filesToModify.join(", ") || "(none)"}

## DOM contract
${blockSpec.domContract}

## Design's own open questions
${blockSpec.openQuestions.join("\n") || "(none)"}

## Tokens needing a name (design values with no existing repo token match)
${newTokens.map((t) => `- ${t.designValue}`).join("\n") || "(none — every value mapped to an existing token)"}

Write the summary, verification criteria, risks, any additional open questions, and names for the new tokens listed above.`;
}
