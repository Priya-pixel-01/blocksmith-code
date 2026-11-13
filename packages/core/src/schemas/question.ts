import { z } from "zod";

export const AemImplementationModeSchema = z.enum(["properties", "sling_model"]);
export type AemImplementationMode = z.infer<typeof AemImplementationModeSchema>;

/** A decision that must be resolved by a human before a build plan is created. */
export const OpenQuestionSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  kind: z.enum(["text", "single_choice"]),
  options: z.array(z.object({ value: z.string(), label: z.string() })).default([]),
  required: z.boolean().default(true),
});
export type OpenQuestion = z.infer<typeof OpenQuestionSchema>;

export const OpenQuestionAnswerSchema = z.object({
  questionId: z.string(),
  value: z.string().min(1),
});
export type OpenQuestionAnswer = z.infer<typeof OpenQuestionAnswerSchema>;
