import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ModelMessage } from "ai";
import { VerdictReportSchema, VerdictIssueSchema, type VerdictReport } from "../schemas/verdict.js";
import type { Plan } from "../schemas/plan.js";
import type { SourceArtifact } from "../schemas/source.js";
import type { RepoProfile } from "../schemas/repo-profile.js";
import type { ModelRouter } from "../llm/router.js";
import { runLint } from "../tools/lint.js";
import { renderBlock } from "../verify/render.js";
import { scanAccessibility } from "../verify/axe.js";

const VisionCritiqueSchema = z.object({
  pass: z.boolean().describe("True only if the rendered block is a faithful, working implementation of the source design — not just 'close enough'."),
  summary: z.string(),
  issues: z.array(VerdictIssueSchema),
});

const SYSTEM_PROMPT = `You are the Verifier for Blocksmith. You compare a rendered Edge Delivery Services block \
against the design it was supposed to implement, and against the plan a human already approved.

You will see:
1. The original source design (image(s)).
2. Screenshots of the actual rendered block at three real breakpoints (mobile/tablet/desktop).
3. The plan's DOM contract and intent.
4. Any lint or accessibility issues already found mechanically — factor these into your issues
   list (as "blocker" if lint failed, matching severity for axe violations) rather than
   re-discovering them from the screenshots.

Judge the render itself — layout, spacing, responsive behavior across the three breakpoints,
whether the content/structure matches the design's intent, and visual fidelity to the source.
Only mark pass:true if there are no blocker or major issues. Be specific: "the image is
misaligned" is not useful, "the image and text are stacked at 1200px but should be side-by-side"
is.`;

export interface VerifyBlockOptions {
  workspaceDir: string;
  repoProfile: RepoProfile;
  plan: Plan;
  sourceArtifact: SourceArtifact;
  router: ModelRouter;
  outDir: string;
  iteration: number;
}

export interface VerifyBlockResult {
  verdict: VerdictReport;
  costUsd: number | null;
}

export async function verifyBlock({ workspaceDir, repoProfile, plan, sourceArtifact, router, outDir, iteration }: VerifyBlockOptions): Promise<VerifyBlockResult> {
  const blockName = plan.blockName;

  const [lint, render, axe] = await Promise.all([
    runLint(workspaceDir, repoProfile.conventions.lintCommand),
    renderBlock({ workspaceDir, blockName, ueFields: plan.ueFields, outDir }),
    scanAccessibility({ workspaceDir, blockName, ueFields: plan.ueFields }),
  ]);

  const mechanicalIssues = buildMechanicalIssues(lint, axe);

  // A block that never even rendered isn't something a vision model can usefully critique —
  // report the failure directly rather than asking it to describe a broken/blank page.
  if (!render.decorated) {
    const verdict = VerdictReportSchema.parse({
      pass: false,
      summary: `The block never finished decorating (no data-block-status="loaded" within the timeout). Console errors: ${render.consoleErrors.join("; ") || "(none)"}`,
      issues: [
        ...mechanicalIssues,
        { severity: "blocker", area: "layout", description: "The block did not finish rendering.", suggestedFix: "Check the block's decorate() for an unhandled error or an unresolved promise." },
      ],
      lintPassed: lint.passed,
      axeViolationCount: axe.violationCount,
      screenshotPaths: render.screenshots.map((s) => s.path),
      iteration,
    });
    // No LLM call was made — the render never finished, so there's nothing for the vision critique to look at.
    return { verdict, costUsd: null };
  }

  const messages = await buildCritiqueMessages(sourceArtifact, render.screenshots, plan, mechanicalIssues);

  const result = await router.generateStructured({
    role: "verifier",
    schema: VisionCritiqueSchema,
    schemaName: "VisionCritique",
    system: SYSTEM_PROMPT,
    messages,
  });

  const allIssues = [...mechanicalIssues, ...result.object.issues];
  const pass = result.object.pass && lint.passed && axe.violationCount === 0;

  const verdict = VerdictReportSchema.parse({
    pass,
    summary: result.object.summary,
    issues: allIssues,
    lintPassed: lint.passed,
    axeViolationCount: axe.violationCount,
    screenshotPaths: render.screenshots.map((s) => s.path),
    iteration,
  });

  return { verdict, costUsd: result.costUsd };
}

function buildMechanicalIssues(lint: { passed: boolean; output: string }, axe: { violationCount: number; violations: Array<{ id: string; description: string; impact: string | null }> }) {
  const issues: VerdictReport["issues"] = [];
  if (!lint.passed) {
    issues.push({ severity: "blocker", area: "style", description: `Lint failed:\n${lint.output.slice(0, 2000)}`, suggestedFix: null });
  }
  for (const v of axe.violations) {
    issues.push({
      severity: v.impact === "critical" || v.impact === "serious" ? "blocker" : "major",
      area: "accessibility",
      description: `${v.id}: ${v.description}`,
      suggestedFix: null,
    });
  }
  return issues;
}

async function buildCritiqueMessages(
  sourceArtifact: SourceArtifact,
  screenshots: Array<{ width: number; label: string; path: string }>,
  plan: Plan,
  mechanicalIssues: VerdictReport["issues"],
): Promise<ModelMessage[]> {
  const contextParts = [
    `## Plan\n${plan.summary}\n\nDOM contract:\n${plan.domContract}`,
    mechanicalIssues.length > 0
      ? `## Issues already found mechanically (lint/accessibility) — include these in your issues list\n${mechanicalIssues.map((i) => `- [${i.severity}] ${i.description}`).join("\n")}`
      : "## No mechanical (lint/accessibility) issues found",
  ];

  const content: Array<{ type: "text"; text: string } | { type: "file"; data: Buffer; mediaType: string }> = [
    { type: "text", text: contextParts.join("\n\n") },
    { type: "text", text: "## Original source design" },
  ];

  for (const imagePath of sourceArtifact.images) {
    content.push({ type: "file", data: await readFile(imagePath), mediaType: "image/png" });
  }

  content.push({ type: "text", text: "## Rendered block screenshots" });
  for (const shot of screenshots) {
    content.push({ type: "text", text: `Breakpoint: ${shot.label} (${shot.width}px)` });
    content.push({ type: "file", data: await readFile(shot.path), mediaType: "image/png" });
  }

  return [{ role: "user", content }];
}
