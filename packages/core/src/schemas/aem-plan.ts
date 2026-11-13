import { z } from "zod";
import { AemComponentSpecSchema } from "./aem-spec.js";
import { AemReuseDecisionSchema } from "./aem-profile.js";

export const AemFilePlanSchema = z.object({
  targetModule: z.string(),
  filesToCreate: z.array(z.string()),
  filesToModify: z.array(z.string()),
  filesToReuse: z.array(z.string()),
  directoriesToCreate: z.array(z.string()),
});
export type AemFilePlan = z.infer<typeof AemFilePlanSchema>;

export const AemPlanSchema = z.object({
  projectType: z.literal("aem"),
  jobId: z.string(),
  componentName: z.string(),
  blockName: z.string(),
  filesToCreate: z.array(z.string()),
  filesToModify: z.array(z.string()),
  domContract: z.string(),
  ueFields: z.array(z.unknown()),
  tokensReused: z.array(z.string()),
  tokensNew: z.array(z.unknown()),
  summary: z.string(),
  componentSpec: AemComponentSpecSchema,
  reuseDecision: AemReuseDecisionSchema,
  filePlan: AemFilePlanSchema,
  dependencies: z.array(z.string()),
  verificationCriteria: z.array(z.string()),
  risks: z.array(z.string()),
  openQuestions: z.array(z.string()),
});
export type AemPlan = z.infer<typeof AemPlanSchema>;
