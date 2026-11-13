import type { RepoProfile } from "../../schemas/repo-profile.js";

/**
 * Deterministic fallback digest — used when no ModelRouter is supplied (tests, or a model-less
 * dry run) and as the input context the Cartographer agent's LLM pass rewrites into prose.
 */
export function renderDigestMarkdown(profile: Omit<RepoProfile, "digestMarkdown">): string {
  const lines: string[] = [];

  lines.push(`# Repo profile: ${profile.workspaceRoot}`);
  lines.push("");
  lines.push(`Project type: **${profile.projectType.toUpperCase()}**`);
  lines.push("");
  lines.push(`Generated ${profile.generatedAt} (cache key \`${profile.cacheKey.slice(0, 12)}\`)`);
  lines.push("");

  lines.push("## Authoring surface");
  if (profile.authoringSurface.hasUniversalEditor) {
    lines.push(`- Universal Editor: yes (${profile.authoringSurface.modelShape} model shape)`);
    if (profile.authoringSurface.modelShape === "fragments") {
      lines.push(`- Block models live in each block's own \`_<name>.json\`, merged via \`npm run ${profile.authoringSurface.buildJsonCommand}\`.`);
      lines.push(`- New blocks need only their own \`_<name>.json\` — it's picked up automatically by the existing glob merge, no manual edits to the root component-*.json files.`);
    } else {
      lines.push(`- Root files (${profile.authoringSurface.rootFiles.componentDefinition}, etc.) are hand-edited directly.`);
    }
  } else {
    lines.push("- Universal Editor: no — no Universal Editor wiring detected.");
  }
  lines.push("");

  if (profile.modules.length > 0) {
    lines.push("## Repository modules");
    for (const module of profile.modules) {
      lines.push(`- **${module.id}** (${module.kind}) at \`${module.path}\` — build: ${module.buildFiles.join(", ")}`);
    }
    lines.push("");
  }

  if (profile.aemComponents.length > 0) {
    lines.push(`## AEM components (${profile.aemComponents.length})`);
    for (const component of profile.aemComponents) {
      lines.push(`- **${component.name}** at \`${component.path}\` — resource type: ${component.resourceType ?? "unknown"}; artifacts: ${component.artifacts.length}`);
    }
    lines.push("");
  }

  lines.push(`## Blocks (${profile.blocks.length})`);
    if (profile.blocks.length === 0) {
    lines.push(
      profile.projectType === "eds"
        ? "- No EDS blocks detected."
        : "- No blocks detected."
    );
  }


  for (const block of profile.blocks) {
    const bits = [
      block.purpose || "(purpose not yet summarized)",
      block.hasUeJson ? "UE-wired" : null,
      block.variants.length ? `variants: ${block.variants.join(", ")}` : null,
    ].filter(Boolean);
    lines.push(`- **${block.name}** (${block.dir}) — ${bits.join("; ")}`);
  }
  lines.push("");

  lines.push("## Design tokens");
  lines.push(`Source: \`${profile.tokens.tokensFile}\``);
  const tokenGroup = (label: string, map: Record<string, string>) => {
    const entries = Object.entries(map);
    if (entries.length === 0) return;
    lines.push(`- ${label}: ${entries.map(([k, v]) => `\`${k}: ${v}\``).join(", ")}`);
  };
  tokenGroup("Colors", profile.tokens.colors);
  tokenGroup("Fonts", profile.tokens.fonts);
  tokenGroup("Font sizes", profile.tokens.fontSizes);
  tokenGroup("Spacing", profile.tokens.spacing);
  if (profile.tokens.breakpoints.length) {
    lines.push(`- Breakpoints: ${profile.tokens.breakpoints.map((b) => `\`${b.mediaQuery}\` (${b.description})`).join(", ")}`);
  }
  lines.push("");

  lines.push("## Conventions");
  lines.push(`- JS linter: ${profile.conventions.jsLinter ?? "none detected"}`);
  lines.push(`- CSS linter: ${profile.conventions.cssLinter ?? "none detected"}`);
  lines.push(`- Lint command: ${profile.conventions.lintCommand ? `npm run ${profile.conventions.lintCommand}` : "none detected"}`);
  lines.push(`- Style: ${profile.conventions.quoteStyle} quotes, semicolons ${profile.conventions.semicolons ? "on" : "off"}`);
  lines.push("");

  if (profile.ueRegistry) {
    lines.push("## Universal Editor registry");
    for (const group of profile.ueRegistry.groups) {
      lines.push(`- **${group.title}** (${group.id}): ${group.componentIds.join(", ")}`);
    }
  }

  return lines.join("\n");
}
