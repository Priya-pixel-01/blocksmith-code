import { z } from "zod";
import { AemReuseDecisionSchema } from "./aem-profile.js";

export const AemImplementationSchema = z.object({
  htl: z.array(z.string()),
  dialog: z.array(z.string()),
  resourceType: z.string().nullable(),
  slingModel: z.string().nullable(),
  frontend: z.array(z.string()),
  backend: z.array(z.string()),
  conventions: z.array(z.string()),
});
export type AemImplementation = z.infer<typeof AemImplementationSchema>;

export const AemComponentSpecSchema = z.object({
  projectType: z.literal("aem"),
  name: z.string().regex(/^[a-z][a-z0-9-]*$/),
  purpose: z.string(),
  requirements: z.array(z.string()),
  reuseDecision: AemReuseDecisionSchema,
  requiredModules: z.array(z.string()),
  requiredFiles: z.array(z.string()),
  dependencies: z.array(z.string()),
  parentPath: z.string().nullable().optional(),
  implementation: AemImplementationSchema,
  acceptanceCriteria: z.array(z.string()),
  openQuestions: z.array(z.string()),
});
export type AemComponentSpec = z.infer<typeof AemComponentSpecSchema>;
