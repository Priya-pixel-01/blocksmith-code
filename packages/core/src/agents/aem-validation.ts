import type { AemPlan } from "../schemas/aem-plan.js";
import type { AemComponentSpec } from "../schemas/aem-spec.js";
import type { RepoProfile } from "../schemas/repo-profile.js";

export interface AemValidationResult {
  isValid: boolean;
  errors: string[];
}

function modulePath(profile: RepoProfile, kind: string, fallback: string): string {
  return profile.modules.find((module) => {
    const path = module.path.toLowerCase();
    return module.kind === kind && path !== "all" && path !== "ui.apps.structure";
  })?.path ?? fallback;
}

function artifactError(path: string, expectedModule: string, detail: string): string {
  return `${detail}: ${path}. Expected a path under ${expectedModule}/.`;
}

function isForbiddenSourcePath(path: string): boolean {
  return path.startsWith("all/") || path.startsWith("ui.apps.structure/") || path.startsWith("blocks/");
}

function validateArtifactPath(path: string, profile: RepoProfile, spec: AemComponentSpec, errors: string[]): void {
  if (!path || path.includes("...")) {
    errors.push(`AEM artifact path must be a concrete repository-relative path: ${path || "<empty>"}`);
    return;
  }
  if (/clientlib\.html/i.test(path)) {
    errors.push(`The shared Granite clientlib.html template is referenced by HTL and must not be listed as a component artifact: ${path}`);
    return;
  }
  if (isForbiddenSourcePath(path)) {
    errors.push(`Invalid AEM source location: ${path}. Aggregate, structure, and EDS source paths are not valid component implementation destinations.`);
    return;
  }

  const applicationModule = modulePath(profile, "application", "ui.apps");
  const contentModule = modulePath(profile, "content", applicationModule);
  const frontendModule = modulePath(profile, "frontend", "ui.frontend");
  const backendModule = modulePath(profile, "backend", "core");
  const normalized = path.replaceAll("\\", "/");
  const file = normalized.split("/").pop() ?? "";
  const modulePrefixes = [applicationModule, contentModule, frontendModule, backendModule, "all", "ui.apps.structure", "blocks"];
  const explicitModule = modulePrefixes.find((module) => normalized.startsWith(`${module}/`));

  // The interpreter schema stores implementation entries as either exact repository paths
  // or relative artifact names. Relative names are resolved by the deterministic planner.
  if (!explicitModule) return;

  if (/\.(html|xml)$/.test(file) || normalized.includes("/_cq_dialog/")) {
    if (!normalized.startsWith(`${applicationModule}/`) && !normalized.startsWith(`${contentModule}/`)) {
      errors.push(artifactError(path, applicationModule, "AEM component and dialog artifacts must belong to the application module"));
    }
    if (!normalized.includes(`/components/${spec.name}/`)) {
      errors.push(`AEM component artifact must use the dedicated ${spec.name} component directory: ${path}`);
    }
    return;
  }
  if (/\.(scss|sass|css|js|ts)$/.test(file)) {
    const hasFrontend = profile.modules.some((module) => module.kind === "frontend" && !["all", "ui.apps.structure"].includes(module.path.toLowerCase()));
    if (!hasFrontend) {
      const existing = profile.aemComponents.find((component) => component.id === spec.reuseDecision.targetComponent);
      const clientlibRoot = existing ? `${existing.path}/clientlib/` : undefined;
      const isLocal = (normalized.startsWith(`${applicationModule}/`) || normalized.startsWith(`${contentModule}/`))
        && (clientlibRoot ? normalized.startsWith(clientlibRoot) : normalized.includes(`/components/${spec.name}/clientlib/`));
      if (!isLocal || !/\.(css|js)$/.test(file)) errors.push(`Without a frontend module, use plain CSS or JavaScript inside the component clientlib: ${path}`);
      return;
    }
    if (!normalized.startsWith(`${frontendModule}/`)) {
      errors.push(artifactError(path, frontendModule, "Frontend artifacts must belong to the frontend module"));
    }
    return;
  }
  if (/\.(java|kt)$/.test(file)) {
    if (!normalized.startsWith(`${backendModule}/`)) {
      errors.push(artifactError(path, backendModule, "Backend artifacts must belong to the backend module"));
    }
    return;
  }
  if (!normalized.startsWith(`${applicationModule}/`) && !normalized.startsWith(`${frontendModule}/`) && !normalized.startsWith(`${backendModule}/`)) {
    errors.push(`AEM artifact is outside a detected source module: ${path}`);
  }
}

export function validateAEMComponentSpec(profile: RepoProfile, spec: AemComponentSpec): AemValidationResult {
  const errors: string[] = [];
  const existing = profile.aemComponents.find((component) => component.name === spec.name);
  const artifacts = [...spec.implementation.htl, ...spec.implementation.dialog, ...spec.implementation.frontend, ...spec.implementation.backend];

  if (!existing && spec.reuseDecision.decision !== "create") {
    errors.push(`New AEM component ${spec.name} must use CREATE, not ${spec.reuseDecision.decision}.`);
  }
  if (!existing && spec.reuseDecision.targetComponent !== null) {
    errors.push(`New AEM component ${spec.name} must not target an existing component.`);
  }
  if (!existing && artifacts.length === 0) {
    errors.push(`New AEM component ${spec.name} must declare at least one implementation artifact.`);
  }
  for (const path of artifacts) validateArtifactPath(path, profile, spec, errors);

  return { isValid: errors.length === 0, errors };
}

export function validateAEMImplementationPlan(profile: RepoProfile, spec: AemComponentSpec, plan: AemPlan): AemValidationResult {
  const errors: string[] = [];
  const paths = [...plan.filePlan.filesToCreate, ...plan.filePlan.filesToModify, ...plan.filePlan.filesToReuse];
  for (const path of paths) validateArtifactPath(path, profile, spec, errors);
  if (spec.reuseDecision.decision === "create" && plan.filePlan.filesToCreate.length === 0) {
    errors.push(`Create plan for ${spec.name} must contain filesToCreate.`);
  }
  return { isValid: errors.length === 0, errors };
}

export function assertAEMValidation(result: AemValidationResult, label: string): void {
  if (!result.isValid) throw new Error(`${label} failed validation:\n${result.errors.join("\n")}`);
}
