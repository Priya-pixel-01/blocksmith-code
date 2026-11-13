import { z } from "zod";

export const ProjectTypeSchema = z.enum(["aem", "eds", "mixed", "unknown"]);
export type ProjectType = z.infer<typeof ProjectTypeSchema>;

export const ConfidenceBandSchema = z.enum(["high", "medium", "low"]);
export type ConfidenceBand = z.infer<typeof ConfidenceBandSchema>;

export const ClassificationEvidenceSchema = z.object({
  signalId: z.string(),
  category: z.string(),
  path: z.string(),
  value: z.string().nullable(),
  weight: z.number(),
  polarity: z.enum(["positive", "negative"]),
  explanation: z.string(),
});
export type ClassificationEvidence = z.infer<typeof ClassificationEvidenceSchema>;

export const ProjectClassificationSchema = z.object({
  projectType: ProjectTypeSchema,
  aemScore: z.number().nonnegative(),
  edsScore: z.number().nonnegative(),
  confidence: z.number().min(0).max(1),
  confidenceBand: ConfidenceBandSchema,
  evidence: z.array(ClassificationEvidenceSchema),
  reason: z.string().nullable(),
  detectorVersion: z.string(),
});
export type ProjectClassification = z.infer<typeof ProjectClassificationSchema>;
