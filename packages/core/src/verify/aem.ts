import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AemPlan } from "../schemas/aem-plan.js";
import type { AemComponentSpec } from "../schemas/aem-spec.js";
import { AemVerificationReportSchema, type AemVerificationIssue, type AemVerificationReport } from "../schemas/aem-verdict.js";
import type { RepoProfile } from "../schemas/repo-profile.js";
import { runLint } from "../tools/lint.js";

function read(root: string, path: string): string | null {
  try {
    return readFileSync(join(root, path), "utf-8");
  } catch {
    return null;
  }
}

function validateXml(path: string, content: string): string | null {
  if (!content.trim().startsWith("<")) return "XML file does not start with an element or declaration.";
  if (content.includes("<sling:resourceType") && !content.includes("sling:resourceType=")) return "Component metadata contains a malformed resource type declaration.";
  const tags = [...content.matchAll(/<([A-Za-z_][\w:.-]*)(?:\s[^<>]*?)?(\/?)>/g)];
  const closing = [...content.matchAll(/<\/([A-Za-z_][\w:.-]*)\s*>/g)];
  if (closing.length > tags.filter((tag) => tag[2] !== "/").length) return "XML contains more closing tags than opening tags.";
  if (!tags.length) return "XML contains no recognizable elements.";
  return null;
}

function validateHtl(path: string, content: string): string[] {
  const issues: string[] = [];
  if (!content.trim()) issues.push("HTL file is empty.");
  if (content.includes("${") && !content.includes("}")) issues.push("HTL expression is missing a closing brace.");
  if (/<img\b/i.test(content) && !/\balt\s*=|data-sly-attribute\.alt/i.test(content)) issues.push("Image markup has no detectable alt attribute.");
  return issues;
}

export interface VerifyAemOptions {
  workspaceDir: string;
  repoProfile: RepoProfile;
  componentSpec: AemComponentSpec;
  plan: AemPlan;
}

export async function verifyAemComponent({ workspaceDir, repoProfile, componentSpec, plan }: VerifyAemOptions): Promise<AemVerificationReport> {
  const issues: AemVerificationIssue[] = [];
  const files = [...plan.filePlan.filesToCreate, ...plan.filePlan.filesToModify];
  for (const path of files) {
    if (!existsSync(join(workspaceDir, path))) {
      issues.push({ severity: "blocker", area: "structure", path, description: "Planned AEM file was not generated.", suggestedFix: "Generate the file listed in the approved AEM file plan." });
    }
  }

  for (const path of files.filter((file) => file.endsWith(".html"))) {
    const content = read(workspaceDir, path);
    if (content == null) continue;
    for (const description of validateHtl(path, content)) issues.push({ severity: "major", area: description.includes("alt") ? "accessibility" : "htl", path, description, suggestedFix: null });
  }
  for (const path of files.filter((file) => file.endsWith(".xml"))) {
    const content = read(workspaceDir, path);
    if (content == null) continue;
    const description = validateXml(path, content);
    if (description) issues.push({ severity: "blocker", area: "xml", path, description, suggestedFix: "Fix the XML structure before deployment." });
  }

  if (componentSpec.implementation.resourceType && !files.some((file) => file.endsWith(".content.xml"))) {
    issues.push({ severity: "major", area: "resource-type", path: plan.filePlan.targetModule, description: "The component has a resource type but no content definition file is planned.", suggestedFix: "Add a .content.xml file with the declared sling:resourceType." });
  }
  if (!repoProfile.modules.some((module) => module.path === plan.filePlan.targetModule)) {
    issues.push({ severity: "blocker", area: "structure", path: plan.filePlan.targetModule, description: "The plan target module is not present in the repository profile.", suggestedFix: "Target an existing AEM module." });
  }

  const lint = await runLint(workspaceDir, repoProfile.conventions.lintCommand);
  if (!lint.passed) issues.push({ severity: "blocker", area: "conventions", path: plan.filePlan.targetModule, description: `Project lint failed: ${lint.output.slice(0, 1000)}`, suggestedFix: "Fix lint errors in the generated artifacts." });
  return AemVerificationReportSchema.parse({
    pass: issues.every((issue) => issue.severity === "minor") && lint.passed,
    summary: issues.length === 0 ? "AEM structure, HTL/XML artifacts, resource type planning, and project lint passed." : `${issues.length} AEM validation issue(s) found.`,
    issues,
    lintPassed: lint.passed,
    filesChecked: files,
    renderAvailable: false,
    accessibilityChecked: files.some((file) => file.endsWith(".html")),
  });
}
