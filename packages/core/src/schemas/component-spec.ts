import { z } from "zod";

export const ComponentRequirementEnvelopeSchema = z.object({
  name: z.string(),
  purpose: z.string(),
  behavior: z.array(z.string()),
  dependencies: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
});
export type ComponentRequirementEnvelope = z.infer<typeof ComponentRequirementEnvelopeSchema>;

export const AemComponentSpecSchema = ComponentRequirementEnvelopeSchema.extend({
  projectType: z.literal("aem"),
  requiredModules: z.array(z.string()),
  resourceType: z.string().nullable(),
  htlTemplates: z.array(z.string()),
  dialogFields: z.array(z.object({ name: z.string(), type: z.string(), required: z.boolean() })),
  frontendAssets: z.array(z.string()),
  clientlibCategories: z.array(z.string()),
  slingModel: z.string().nullable(),
  backendRequirements: z.array(z.string()),
  requiredArtifacts: z.array(z.string()),
});
export type AemComponentSpec = z.infer<typeof AemComponentSpecSchema>;

export const MissingComponentSchema = z.object({
  name: z.string(),
  purpose: z.string(),
  requiredModules: z.array(z.string()),
  requiredArtifacts: z.array(z.string()),
  expectedLocations: z.array(z.string()),
  dependencies: z.array(z.string()),
  evidence: z.array(z.string()),
  rationale: z.string(),
});
export type MissingComponent = z.infer<typeof MissingComponentSchema>;
