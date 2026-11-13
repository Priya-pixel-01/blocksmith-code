import type { AemComponent, AemReuseDecision } from "../schemas/aem-profile.js";
import { AemFilePlanSchema, AemPlanSchema, type AemFilePlan, type AemPlan } from "../schemas/aem-plan.js";
import type { AemComponentSpec } from "../schemas/aem-spec.js";
import type { RepoProfile } from "../schemas/repo-profile.js";
import { AEM_PLANNER_PROMPT } from "./aem-prompts.js";
import type { ModelRouter } from "../llm/router.js";
import { assertAEMValidation, validateAEMImplementationPlan } from "./aem-validation.js";

function moduleByKind(profile: RepoProfile, kinds: string[], fallback: string): string {
  const sourceModules = profile.modules.filter((module) => {
    if (!kinds.includes(module.kind)) return false;
    const path = module.path.toLowerCase();
    return path !== "all" && path !== "ui.apps.structure";
  });
  return sourceModules.find((module) => module.path === fallback || module.id === fallback)?.path ?? sourceModules[0]?.path ?? fallback;
}

function componentRoot(profile: RepoProfile, spec: AemComponentSpec, decision: AemReuseDecision): string {
  const existing = decision.targetComponent ? profile.aemComponents.find((component) => component.id === decision.targetComponent) : undefined;
  if (existing) return existing.path;
  const module = moduleByKind(profile, ["application", "content"], "ui.apps");
  const appName = (spec.implementation.resourceType?.split("/")[0] || "apps").replace(/[^a-zA-Z0-9_-]/g, "");
  return `${module}/src/main/content/jcr_root/apps/${appName}/components/${spec.name}`;
}

function addFile(files: Set<string>, path: string): void {
  if (path && !path.endsWith("/")) files.add(path.replaceAll("\\", "/"));
}

function fileName(path: string, fallback: string): string {
  const normalized = path.replaceAll("\\", "/");
  const matches = normalized.match(/[A-Za-z0-9_-]+\.(?:content\.xml|html|scss|sass|css|js|ts|java|kt)(?=\s|$)/gi);
  return matches?.[matches.length - 1] ?? fallback;
}

function componentArtifactPath(path: string, root: string, fallback: string): string {
  const name = fileName(path, fallback);
  return `${root}/${name}`;
}

function dialogArtifactPath(path: string, root: string): string {
  return `${root}/_cq_dialog/${fileName(path, ".content.xml")}`;
}

function frontendArtifactPath(path: string, module: string | undefined, componentName: string, root: string): string {
  if (!module) {
    const name = fileName(path, `${componentName}.css`).replace(/\.(scss|sass)$/i, ".css").replace(/\.ts$/i, ".js");
    return `${root}/clientlib/${name.endsWith(".css") ? "css" : "js"}/${name}`;
  }
  return `${module}/src/main/webpack/components/${componentName}/${fileName(path, `${componentName}.scss`)}`;
}

function backendArtifactPath(path: string, module: string): string {
  const normalized = path.replaceAll("\\", "/");
  const javaSource = normalized.match(/(?:^|\/)src\/main\/java\/(.+?\.java)(?=\s|$)/i)?.[1];
  if (javaSource) return `${module}/src/main/java/${javaSource}`;
  const relativeJavaPath = normalized.match(/((?:[A-Za-z0-9_$-]+\/)*[A-Za-z0-9_$-]+\.java)(?=\s|$)/i)?.[1];
  return `${module}/src/main/java/${relativeJavaPath ?? fileName(path, "ComponentModel.java")}`;
}

export function computeAEMFilePlan(profile: RepoProfile, spec: AemComponentSpec, reuseDecision: AemReuseDecision = spec.reuseDecision): AemFilePlan {
  const root = componentRoot(profile, spec, reuseDecision);
  const frontendModule = profile.modules.some((module) => module.kind === "frontend" && !["all", "ui.apps.structure"].includes(module.path.toLowerCase()))
    ? moduleByKind(profile, ["frontend"], "ui.frontend") : undefined;
  const backendModule = moduleByKind(profile, ["backend"], "core");
  const filesToCreate = new Set<string>();
  const filesToModify = new Set<string>();
  const filesToReuse = new Set<string>();

  if (reuseDecision.decision === "reuse") {
    const existing = profile.aemComponents.find((component) => component.id === reuseDecision.targetComponent);
    for (const file of existing?.artifacts ?? []) addFile(filesToReuse, file);
    for (const file of spec.implementation.frontend) addFile(filesToReuse, frontendArtifactPath(file, frontendModule, spec.name, root));
    for (const file of spec.implementation.backend) addFile(filesToReuse, backendArtifactPath(file, backendModule));
  } else {
    const componentFiles = reuseDecision.decision === "create" ? filesToCreate : filesToModify;
    for (const file of spec.implementation.htl) addFile(componentFiles, componentArtifactPath(file, root, `${spec.name}.html`));
    for (const file of spec.implementation.dialog) addFile(componentFiles, dialogArtifactPath(file, root));
    if (spec.implementation.htl.length === 0) addFile(componentFiles, `${root}/${spec.name}.html`);
    if (spec.implementation.dialog.length > 0) addFile(componentFiles, `${root}/_cq_dialog/.content.xml`);
    addFile((reuseDecision.decision === "create" ? filesToCreate : filesToModify), `${root}/.content.xml`);
  }

  if (reuseDecision.decision !== "reuse") {
    const generatedFiles = reuseDecision.decision === "create" ? filesToCreate : filesToModify;
    for (const file of spec.implementation.frontend) addFile(generatedFiles, frontendArtifactPath(file, frontendModule, spec.name, root));
    for (const file of spec.implementation.backend) addFile(generatedFiles, backendArtifactPath(file, backendModule));
  }

  if (!frontendModule && spec.implementation.frontend.length > 0) {
    const files = reuseDecision.decision === "reuse" ? filesToReuse : reuseDecision.decision === "create" ? filesToCreate : filesToModify;
    addFile(files, `${root}/clientlib/.content.xml`);
    if ([...files].some((path) => path.startsWith(`${root}/clientlib/css/`))) addFile(files, `${root}/clientlib/css.txt`);
    if ([...files].some((path) => path.startsWith(`${root}/clientlib/js/`))) addFile(files, `${root}/clientlib/js.txt`);
  }

  const allFiles = [...filesToCreate, ...filesToModify, ...filesToReuse].sort();
  const directoriesToCreate = [...new Set(allFiles.map((file) => file.slice(0, file.lastIndexOf("/"))).filter(Boolean))].sort();
  const targetModule = root.split("/")[0] ?? moduleByKind(profile, ["application", "content"], "ui.apps");
  const plan = AemFilePlanSchema.parse({ targetModule, filesToCreate: [...filesToCreate].sort(), filesToModify: [...filesToModify].sort(), filesToReuse: [...filesToReuse].sort(), directoriesToCreate });
  validateAEMFilePlan(profile, spec, plan);
  return plan;
}

export function validateAEMFilePlan(profile: RepoProfile, spec: AemComponentSpec, plan: AemFilePlan): void {
  const modules = new Set(profile.modules.map((module) => module.path));
  for (const path of [...plan.filesToCreate, ...plan.filesToModify, ...plan.filesToReuse]) {
    if (path.startsWith("blocks/")) throw new Error(`AEM file plan cannot target EDS blocks: ${path}`);
    const module = path.split("/")[0] ?? "";
    if (modules.size > 0 && !modules.has(module)) throw new Error(`AEM file plan targets unknown module "${module}": ${path}`);
  }
  if (!spec.requiredModules.every((module) => modules.size === 0 || modules.has(module))) {
    throw new Error("AEM component specification requires modules that are not present in the repository");
  }
  if (!plan.targetModule) throw new Error("AEM file plan must identify a target module");
}

export interface CreateAemPlanOptions {
  jobId: string;
  repoProfile: RepoProfile;
  componentSpec: AemComponentSpec;
  reuseDecision: AemReuseDecision;
  router: ModelRouter;
  feedback?: string;
}

export async function createAemPlan({ jobId, repoProfile, componentSpec, reuseDecision, router, feedback }: CreateAemPlanOptions): Promise<{ plan: AemPlan; costUsd: number | null }> {
  const filePlan = computeAEMFilePlan(repoProfile, componentSpec, reuseDecision);
  const result = await router.generateStructured({
    role: "planner",
    schema: AemPlanSchema.pick({ summary: true, verificationCriteria: true, risks: true, openQuestions: true }),
    schemaName: "AemPlanNarrative",
    system: AEM_PLANNER_PROMPT,
    prompt: `## Repository\n${repoProfile.digestMarkdown}\n\n## Component specification\n${JSON.stringify(componentSpec, null, 2)}\n\n## Reuse decision\n${JSON.stringify(reuseDecision, null, 2)}\n\n## Deterministic file plan\n${JSON.stringify(filePlan, null, 2)}\n${feedback ? `\n## Feedback\n${feedback}` : ""}`,
  });
  const plan = AemPlanSchema.parse({
    projectType: "aem",
    jobId,
    componentName: componentSpec.name,
    blockName: componentSpec.name,
    filesToCreate: filePlan.filesToCreate,
    filesToModify: filePlan.filesToModify,
    domContract: componentSpec.implementation.htl.join("\n"),
    ueFields: [],
    tokensReused: [],
    tokensNew: [],
    summary: result.object.summary,
    componentSpec: { ...componentSpec, reuseDecision },
    reuseDecision,
    filePlan,
    dependencies: componentSpec.dependencies,
    verificationCriteria: result.object.verificationCriteria,
    risks: result.object.risks,
    openQuestions: [...new Set([...componentSpec.openQuestions, ...result.object.openQuestions])],
  });
  assertAEMValidation(validateAEMImplementationPlan(repoProfile, componentSpec, plan), "AEM implementation plan");
  return { plan, costUsd: result.costUsd };
}
