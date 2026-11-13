import { readFile } from "node:fs/promises";
import type { ModelMessage } from "ai";
import type { ModelRouter } from "../llm/router.js";
import type { RepoProfile } from "../schemas/repo-profile.js";
import { AemComponentSpecSchema, type AemComponentSpec } from "../schemas/aem-spec.js";
import type { AemReuseDecision } from "../schemas/aem-profile.js";
import type { SourceArtifact } from "../schemas/source.js";
import type { AemImplementationMode } from "../schemas/question.js";
import { AEM_INTERPRETER_PROMPT } from "./aem-prompts.js";
import { validateAEMComponentSpec } from "./aem-validation.js";

const MAX_AEM_INTERPRETER_RETRIES = 2;

const EMPTY_REUSE: AemReuseDecision = {
  decision: "create",
  targetComponent: null,
  rationale: "Reuse analysis has not run yet.",
  confidence: 0,
  evidence: [],
  gaps: [],
};

export interface InterpretAemDesignOptions {
  artifact: SourceArtifact;
  repoProfile: RepoProfile;
  router: ModelRouter;
  reuseDecision?: AemReuseDecision;
  implementationMode?: AemImplementationMode;
  feedback?: string;
}

export interface InterpretAemDesignResult {
  componentSpec: AemComponentSpec;
  costUsd: number | null;
}

export async function interpretAemDesign({ artifact, repoProfile, router, reuseDecision = EMPTY_REUSE, implementationMode, feedback }: InterpretAemDesignOptions): Promise<InterpretAemDesignResult> {
  let currentFeedback = feedback;
  let totalCost = 0;

  for (let attempt = 0; attempt <= MAX_AEM_INTERPRETER_RETRIES; attempt++) {
    const messages = await buildMessages(artifact, repoProfile, reuseDecision, implementationMode, currentFeedback);
    const result = await router.generateStructured({
      role: "interpreter",
      schema: AemComponentSpecSchema,
      schemaName: "AemComponentSpec",
      system: AEM_INTERPRETER_PROMPT,
      messages,
    });
    totalCost += result.costUsd ?? 0;
    const componentSpec = AemComponentSpecSchema.parse({ ...result.object, reuseDecision });
    const validation = validateAEMComponentSpec(repoProfile, componentSpec);
    if (validation.isValid) return { componentSpec, costUsd: totalCost || null };

    currentFeedback = [
      "The previous AEM component specification failed executable validation. Correct every error before returning a replacement.",
      ...validation.errors.map((error) => `- ${error}`),
    ].join("\n");
  }

  throw new Error(`AEM component specification failed validation after ${MAX_AEM_INTERPRETER_RETRIES + 1} attempts. Last validation errors:\n${currentFeedback ?? "No validation details available."}`);
}

async function buildMessages(artifact: SourceArtifact, repoProfile: RepoProfile, reuseDecision: AemReuseDecision, implementationMode?: AemImplementationMode, feedback?: string): Promise<ModelMessage[]> {
  const context = [
    `## Repository profile\n${repoProfile.digestMarkdown}`,
    `## AEM modules\n${JSON.stringify(repoProfile.modules, null, 2)}`,
    `## Existing AEM components\n${JSON.stringify(repoProfile.aemComponents, null, 2)}`,
    `## Reuse decision\n${JSON.stringify(reuseDecision, null, 2)}`,
    implementationMode ? `## Required implementation mode\n${implementationMode === "properties" ? "Properties-based: do not propose Sling Models, Java backend files, or backend services." : "Sling Model: use the repository's existing core model and implementation conventions; propose Java artifacts only for required server-side behavior."}` : "",
    feedback ? `## Human feedback\n${feedback}` : "",
    artifact.textContent ? `## Extracted source text\n${artifact.textContent.slice(0, 8000)}` : "",
    artifact.structured ? `## Structured source\n${JSON.stringify(artifact.structured).slice(0, 12000)}` : "",
    `## Source origin\n${artifact.originGeoRef}`,
  ].filter(Boolean).join("\n\n");
  const content: Array<{ type: "text"; text: string } | { type: "file"; data: Buffer; mediaType: string }> = [{ type: "text", text: context }];
  for (const imagePath of artifact.images) content.push({ type: "file", data: await readFile(imagePath), mediaType: "image/png" });
  return [{ role: "user", content }];
}
