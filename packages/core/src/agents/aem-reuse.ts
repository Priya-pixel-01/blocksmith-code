import type { AemComponent, AemReuseDecision } from "../schemas/aem-profile.js";

export interface AemComponentRequest {
  name: string;
  implementationMode?: "properties" | "sling_model";
  resourceType?: string | null;
  dialogPaths?: string[];
  htlPaths?: string[];
  frontendAssets?: string[];
  backendTypes?: string[];
  variants?: string[];
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function identityTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map((token) => token === "cta" ? "button" : token));
}

function artifactMatches(existing: string, requested: string): boolean {
  const actual = existing.replaceAll("\\", "/");
  const desired = requested.replaceAll("\\", "/");
  return actual === desired || actual.endsWith(`/${desired}`) || desired.endsWith(`/${actual}`);
}

function includesAll(existing: string[] | undefined, requested: string[]): boolean {
  const available = existing ?? [];
  return requested.every((value) => available.some((candidate) => artifactMatches(candidate, value)));
}

function similarity(request: AemComponentRequest, component: AemComponent): number {
  const requestedName = normalize(request.name);
  const existingName = normalize(component.name);
  if (requestedName === existingName) return 1;
  const requestedTokens = identityTokens(request.name);
  const existingTokens = identityTokens(component.name);
  const overlap = [...requestedTokens].filter((token) => existingTokens.has(token)).length;
  const union = new Set([...requestedTokens, ...existingTokens]).size;
  const score = union === 0 ? 0 : overlap / union;
  return score >= 0.8 ? score : 0;
}

function gaps(request: AemComponentRequest, component: AemComponent): string[] {
  const missing: string[] = [];
  if (request.resourceType && component.resourceType !== request.resourceType) missing.push("resource type differs");
  if (!includesAll(component.dialogPaths, request.dialogPaths ?? [])) missing.push("dialog differs or is missing");
  if (!includesAll(component.htlPaths, request.htlPaths ?? [])) missing.push("HTL implementation differs or is missing");
  if (!includesAll(component.frontendAssets, request.frontendAssets ?? [])) missing.push("frontend implementation differs or is missing");
  if (!includesAll(component.backendTypes, request.backendTypes ?? [])) missing.push("backend implementation differs or is missing");
  if (request.implementationMode === "sling_model" && (component.backendTypes ?? []).length === 0) missing.push("Sling Model behavior is missing");
  if (!includesAll(component.variants, request.variants ?? [])) missing.push("variant/configuration differs or is missing");
  return missing;
}

export function analyzeAemReuse(components: AemComponent[], request: AemComponentRequest): AemReuseDecision {
  const ranked = components
    .map((component) => ({ component, score: similarity(request, component) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.component.id.localeCompare(b.component.id));
  const candidate = ranked[0];

  if (!candidate) {
    return {
      decision: "create",
      targetComponent: null,
      rationale: "No existing AEM component has a matching name, resource type, or related identity.",
      confidence: 0.95,
      evidence: [`requested component: ${request.name}`],
      gaps: ["component does not exist"],
    };
  }

  const missing = gaps(request, candidate.component);
  const exactIdentity = normalize(request.name) === normalize(candidate.component.name);
  if (exactIdentity && missing.length === 0) {
    return {
      decision: "reuse",
      targetComponent: candidate.component.id,
      rationale: "An existing component matches the requested identity and implementation details.",
      confidence: 0.98,
      evidence: [candidate.component.path, candidate.component.resourceType ?? "no resource type"],
      gaps: [],
    };
  }

  const identityMatch = exactIdentity;
  const decision = identityMatch
    ? missing.some((gap) => gap.includes("Sling Model") || gap.includes("backend"))
      ? "extend"
      : "modify"
    : "extend";
  return {
    decision,
    targetComponent: candidate.component.id,
    rationale: identityMatch
      ? "An existing component matches the requested identity but requires implementation changes."
      : "A related component exists and can provide the base implementation for the requested component.",
    confidence: identityMatch ? 0.86 : 0.68,
    evidence: [candidate.component.path, ...missing],
    gaps: missing,
  };
}
