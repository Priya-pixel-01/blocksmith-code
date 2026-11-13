import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { tool } from "ai";
import type { ModelRouter } from "../llm/router.js";
import type { RepoProfile } from "../schemas/repo-profile.js";
import type { AemComponentSpec } from "../schemas/aem-spec.js";
import type { AemPlan } from "../schemas/aem-plan.js";
import { createFsTools } from "../tools/fs.js";
import { createRunLintTool, runLint, type LintResult } from "../tools/lint.js";
import { resolveInSandbox } from "../tools/sandbox.js";
import { AEM_BUILDER_PROMPT } from "./aem-prompts.js";
import { assertAEMValidation, validateAEMImplementationPlan } from "./aem-validation.js";

export interface BuildAemOptions {
  workspaceDir: string;
  repoProfile: RepoProfile;
  componentSpec: AemComponentSpec;
  plan: AemPlan;
  router: ModelRouter;
  feedback?: string;
}

export interface BuildAemResult {
  filesWritten: string[];
  filesMissing: string[];
  lint: LintResult;
  summary: string;
  costUsd: number | null;
}

export async function buildAemComponent({ workspaceDir, repoProfile, componentSpec, plan, router, feedback }: BuildAemOptions): Promise<BuildAemResult> {
  assertAEMValidation(validateAEMImplementationPlan(repoProfile, componentSpec, plan), "AEM implementation plan");
  const allowedPaths = [...plan.filePlan.filesToCreate, ...plan.filePlan.filesToModify];
  const tools = createAemBuilderTools(workspaceDir, repoProfile, allowedPaths);
  const loop = await router.runAgentLoop({
    role: "builder",
    system: AEM_BUILDER_PROMPT,
    prompt: `## Repository profile\n${repoProfile.digestMarkdown}\n\n## Component specification\n${JSON.stringify(componentSpec, null, 2)}\n\n## Approved file plan\n${JSON.stringify(plan.filePlan, null, 2)}\n\n## Approved files\n${allowedPaths.map((path) => `- ${path}`).join("\n")}\n${feedback ? `\n## Verification feedback\n${feedback}` : ""}\n\nImplement the component now. Read sibling components first and run lint before finishing.`,
    tools,
    maxSteps: 24,
  });
  const filesWritten = allowedPaths.filter((path) => existsSync(resolveInSandbox(workspaceDir, path)));
  const filesMissing = allowedPaths.filter((path) => !filesWritten.includes(path));
  validateGeneratedAemContracts(workspaceDir, plan, filesWritten);
  const lint = await runLint(workspaceDir, repoProfile.conventions.lintCommand);
  return { filesWritten, filesMissing, lint, summary: loop.text, costUsd: loop.costUsd };
}

export function validateGeneratedAemContracts(workspaceDir: string, plan: AemPlan, filesWritten: string[]): void {
  const dialogFiles = filesWritten.filter((path) => path.includes("/_cq_dialog/") && path.endsWith(".content.xml"));
  const htlFiles = filesWritten.filter((path) => path.endsWith(".html"));
  const declaresLink = dialogFiles.some((path) => readFileSync(resolveInSandbox(workspaceDir, path), "utf-8").includes('name="./link"'));
  const usesSlingModel = Boolean(plan.componentSpec?.implementation.slingModel);
  const consumesLink = htlFiles.some((path) => {
    const htl = readFileSync(resolveInSandbox(workspaceDir, path), "utf-8");
    return htl.includes("properties.link") || (usesSlingModel && htl.includes("model.link"));
  });

  if (declaresLink && !consumesLink) {
    throw new Error(`AEM implementation for ${plan.componentName} declares a ./link dialog field but no generated HTL consumes properties.link.`);
  }

  const plannedJavaFiles = [...plan.filePlan.filesToCreate, ...plan.filePlan.filesToModify].filter((path) => path.endsWith(".java"));
  const modelClass = plan.componentSpec.implementation.slingModel;
  if (!modelClass && plannedJavaFiles.length === 0) return;
  if (plannedJavaFiles.length === 0) {
    throw new Error(`AEM implementation for ${plan.componentName} declares a Sling Model but has no approved Java artifacts.`);
  }

  const missingJavaFiles = plannedJavaFiles.filter((path) => !filesWritten.includes(path));
  if (missingJavaFiles.length > 0) {
    throw new Error(`AEM Sling Model generation omitted approved Java file(s): ${missingJavaFiles.join(", ")}`);
  }

  for (const path of plannedJavaFiles) {
    const content = readFileSync(resolveInSandbox(workspaceDir, path), "utf-8");
    const sourceRoot = "/src/main/java/";
    const packageRelativePath = path.includes(sourceRoot) ? path.slice(path.indexOf(sourceRoot) + sourceRoot.length) : "";
    const expectedPackage = packageRelativePath.includes("/") ? packageRelativePath.slice(0, packageRelativePath.lastIndexOf("/")).replaceAll("/", ".") : "";
    const expectedType = basename(path, ".java");
    if (!expectedPackage || !new RegExp(`\\bpackage\\s+${escapeRegExp(expectedPackage)}\\s*;`).test(content)) {
      throw new Error(`Generated Java file ${path} does not declare its path-matching package ${expectedPackage || "<missing>"}.`);
    }
    if (!new RegExp(`\\b(class|interface|enum|record)\\s+${escapeRegExp(expectedType)}\\b`).test(content)) {
      throw new Error(`Generated Java file ${path} does not declare type ${expectedType}.`);
    }
    if (path.includes("/models/impl/") && (!content.includes("@Model") || !content.includes(plan.componentSpec.implementation.resourceType ?? ""))) {
      throw new Error(`Generated Sling Model implementation ${path} must declare @Model for resource type ${plan.componentSpec.implementation.resourceType}.`);
    }
  }

  if (modelClass) {
    const htlUsesModel = htlFiles.some((path) => {
      const htl = readFileSync(resolveInSandbox(workspaceDir, path), "utf-8");
      return htl.includes(modelClass) || htl.includes(modelClass.split(".").at(-1) ?? modelClass);
    });
    if (!htlUsesModel) {
      throw new Error(`AEM implementation for ${plan.componentName} plans Sling Model ${modelClass} but generated HTL does not bind that model.`);
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createAemBuilderTools(workspaceDir: string, repoProfile: RepoProfile, allowedPaths: string[]) {
  const base = createFsTools(workspaceDir);
  const lintTools = createRunLintTool(workspaceDir, repoProfile);
  const allowedSet = new Set(allowedPaths);
  const deny = (path: string) => ({ error: `"${path}" is not in this AEM job's approved file list.` });
  const fs_write = tool({
    description: base.fs_write.description,
    inputSchema: base.fs_write.inputSchema,
    execute: async (input: { path: string; content: string }, options) => allowedSet.has(input.path) ? base.fs_write.execute!(input, options) : deny(input.path),
  });
  const fs_patch = tool({
    description: base.fs_patch.description,
    inputSchema: base.fs_patch.inputSchema,
    execute: async (input: { path: string; oldString: string; newString: string; replaceAll: boolean }, options) => allowedSet.has(input.path) ? base.fs_patch.execute!(input, options) : deny(input.path),
  });
  return { fs_list: base.fs_list, fs_read: base.fs_read, fs_search: base.fs_search, fs_write, fs_patch, ...lintTools };
}
