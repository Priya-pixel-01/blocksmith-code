import { z } from "zod";

/** Verifier's vision-critique output, produced after each render/screenshot pass. */
export const VerdictIssueSchema = z.object({
  severity: z.enum(["blocker", "major", "minor"]),
  area: z.enum(["layout", "responsive", "accessibility", "content", "style", "ue-wiring"]),
  description: z.string(),
  suggestedFix: z.string().nullable(),
});
export type VerdictIssue = z.infer<typeof VerdictIssueSchema>;

export const VerdictReportSchema = z.object({
  pass: z.boolean(),
  summary: z.string(),
  issues: z.array(VerdictIssueSchema),
  lintPassed: z.boolean(),
  axeViolationCount: z.number().int(),
  screenshotPaths: z.array(z.string()),
  iteration: z.number().int(),
});
export type VerdictReport = z.infer<typeof VerdictReportSchema>;
