import { z } from "zod";
import { UeFieldSchema } from "./block-spec.js";

/** Reuse Analyst output. */
export const ReuseDecisionSchema = z.object({
  decision: z.enum(["create", "extend", "variant"]),
  targetBlock: z.string().nullable().describe("Existing block name, required when decision is 'extend' or 'variant'."),
  rationale: z.string(),
  confidence: z.number(),
  category: z.enum(["exact-match", "reusable-with-configuration", "reusable-with-modification", "similar-new-implementation", "new-component-required"]).optional(),
  evidence: z.array(z.string()).optional(),
  gaps: z.array(z.string()).optional(),
});
export type ReuseDecision = z.infer<typeof ReuseDecisionSchema>;

/** Planner output: the human-facing plan shown at the approval gate. Nothing is written to the repo yet. */
export const PlanSchema = z.object({
  jobId: z.string(),
  blockName: z.string(),
  summary: z.string().describe("Markdown. What will be built and why, in plain language for a reviewer."),
  reuseDecision: ReuseDecisionSchema,
  filesToCreate: z.array(z.string()),
  filesToModify: z.array(z.string()),
  domContract: z.string(),
  ueFields: z.array(UeFieldSchema),
  tokensReused: z.array(z.string()),
  tokensNew: z.array(z.object({ name: z.string(), value: z.string(), rationale: z.string() })),
  verificationCriteria: z.array(z.string()),
  risks: z.array(z.string()),
  openQuestions: z.array(z.string()),
});
export type Plan = z.infer<typeof PlanSchema>;

export const PlanFeedbackSchema = z.object({
  jobId: z.string(),
  approved: z.boolean(),
  feedback: z.string().nullable().describe("Required when approved is false — re-runs Interpreter/Reuse/Planner with this appended."),
});
export type PlanFeedback = z.infer<typeof PlanFeedbackSchema>;
