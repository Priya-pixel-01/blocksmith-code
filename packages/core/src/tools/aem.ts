import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AemComponent, AemModule } from "../schemas/aem-profile.js";
import type { RepoProfile } from "../schemas/repo-profile.js";

export interface AemArtifactIssue {
  path: string;
  message: string;
}

export function inspectAemRepository(profile: RepoProfile): { modules: AemModule[]; components: AemComponent[] } {
  return { modules: profile.modules, components: profile.aemComponents };
}

export function validateAemArtifacts(root: string, profile: RepoProfile): AemArtifactIssue[] {
  const issues: AemArtifactIssue[] = [];
  for (const component of profile.aemComponents) {
    for (const path of component.htlPaths) {
      if (!existsSync(join(root, path))) issues.push({ path, message: "HTL file is referenced by the profile but does not exist." });
    }
    for (const path of [...component.dialogPaths, ...component.configurationPaths]) {
      const absolute = join(root, path);
      if (!existsSync(absolute)) {
        issues.push({ path, message: "AEM XML artifact is referenced by the profile but does not exist." });
        continue;
      }
      const content = readFileSync(absolute, "utf-8").trim();
      if (!content.startsWith("<")) issues.push({ path, message: "AEM XML artifact does not begin with an XML element." });
    }
    if (!component.resourceType) issues.push({ path: component.path, message: "Component has no detected sling:resourceType." });
  }
  return issues;
}
