import { z } from "zod";

export const AemVerificationIssueSchema = z.object({
  severity: z.enum(["blocker", "major", "minor"]),
  area: z.enum(["htl", "xml", "resource-type", "structure", "accessibility", "conventions"]),
  path: z.string(),
  description: z.string(),
  suggestedFix: z.string().nullable(),
});
export type AemVerificationIssue = z.infer<typeof AemVerificationIssueSchema>;

export const AemVerificationReportSchema = z.object({
  pass: z.boolean(),
  summary: z.string(),
  issues: z.array(AemVerificationIssueSchema),
  lintPassed: z.boolean(),
  filesChecked: z.array(z.string()),
  renderAvailable: z.boolean(),
  accessibilityChecked: z.boolean(),
});
export type AemVerificationReport = z.infer<typeof AemVerificationReportSchema>;
