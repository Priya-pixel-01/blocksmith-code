import { z } from "zod";

export const JobStatusSchema = z.enum([
  "created",
  "ingesting",
  "analyzing",
  "awaiting_answers",
  "planning",
  "awaiting_approval",
  "code_only",
  "building",
  "verifying",
  "writing",
  "done",
  "deployed",
  "post_feedback_building",
  "post_feedback_verifying",
  "failed",
  "rejected",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobEventSchema = z.object({
  jobId: z.string(),
  ts: z.string(),
  type: z.enum(["status", "agent-message", "tool-call", "tool-result", "error"]),
  status: JobStatusSchema.nullable(),
  agent: z.string().nullable(),
  message: z.string(),
  data: z.unknown().nullable(),
});
export type JobEvent = z.infer<typeof JobEventSchema>;
