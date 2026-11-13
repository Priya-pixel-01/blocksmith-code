import { z } from "zod";

export const AemModuleSchema = z.object({
  id: z.string(),
  path: z.string(),
  kind: z.enum(["application", "content", "frontend", "backend", "dispatcher", "test", "other"]),
  buildFiles: z.array(z.string()),
  sourceRoots: z.array(z.string()),
  testRoots: z.array(z.string()),
  dependencies: z.array(z.string()),
});
export type AemModule = z.infer<typeof AemModuleSchema>;

export const AemArtifactSchema = z.object({
  kind: z.enum(["htl", "dialog", "content-definition", "component-metadata", "clientlib", "java", "osgi-config", "other"]),
  path: z.string(),
  componentId: z.string().nullable(),
});
export type AemArtifact = z.infer<typeof AemArtifactSchema>;

export const AemComponentSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  resourceType: z.string().nullable(),
  dialogPaths: z.array(z.string()).default([]),
  htlPaths: z.array(z.string()).default([]),
  clientlibPaths: z.array(z.string()).default([]),
  configurationPaths: z.array(z.string()).default([]),
  artifacts: z.array(z.string()),
  frontendAssets: z.array(z.string()),
  backendTypes: z.array(z.string()),
  variants: z.array(z.string()).default([]),
  dependencies: z.array(z.string()),
  tests: z.array(z.string()),
});
export type AemComponent = z.infer<typeof AemComponentSchema>;

export const AemReuseDecisionSchema = z.object({
  decision: z.enum(["reuse", "extend", "modify", "create"]),
  targetComponent: z.string().nullable(),
  rationale: z.string(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()),
  gaps: z.array(z.string()),
});
export type AemReuseDecision = z.infer<typeof AemReuseDecisionSchema>;

export const RepositoryRelationshipSchema = z.object({
  type: z.string(),
  source: z.string(),
  target: z.string(),
  status: z.enum(["present", "missing", "unknown"]),
  evidence: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  detectorVersion: z.string(),
  profileVersion: z.string(),
  notes: z.string().nullable(),
});
export type RepositoryRelationship = z.infer<typeof RepositoryRelationshipSchema>;

