import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RepoProfile, ProjectType } from "../../schemas/repo-profile.js";
import type { ModelRouter } from "../../llm/router.js";
import {
  isGitRepo,
  computeCacheKey,
  detectProjectClassification,
  detectAuthoringSurface,
  scanBlocks,
  parseTokens,
  detectConventions,
  parseUeRegistry,
} from "./extract.js";
import { renderDigestMarkdown } from "./digest.js";
import { extractAemRepository } from "./aem-extract.js";

const CartographerEnrichmentSchema = z.object({
  blockPurposes: z
    .array(z.object({ name: z.string(), purpose: z.string().describe("One sentence: what this block does, for someone unfamiliar with the repo.") }))
    .describe("One entry per block passed in the prompt."),
});

/**
 * Builds a RepoProfile for `root`. Structural facts (block inventory, tokens, breakpoints, UE
 * registry, conventions) come entirely from deterministic parsing in extract.ts — there is
 * nothing for a model to get wrong there. The only thing delegated to an LLM is writing a
 * one-line purpose for each block that has no README to draw one from, and the human-readable
 * digest prose. Pass no `router` to get a fully deterministic profile (used in tests and as a
 * safe fallback if the LLM call fails).
 */
export async function buildRepoProfile(root: string, router?: ModelRouter): Promise<RepoProfile> {
  const classification = detectProjectClassification(root);
  const projectType = classification.projectType;
  const gitRepo = isGitRepo(root);
  const cacheKey = computeCacheKey(root);
  const authoringSurface = detectAuthoringSurface(root);
  const blocks = scanBlocks(root);
  const tokens = parseTokens(root);
  const conventions = detectConventions(root);
  const ueRegistry = parseUeRegistry(root, authoringSurface);
  const aem = projectType === "aem" || projectType === "mixed"
    ? extractAemRepository(root)
    : { modules: [], artifacts: [], components: [], relationships: [] };

  let enrichedBlocks = blocks;

  const blocksNeedingPurpose = blocks.filter((b) => !b.purpose);
  if (router && blocksNeedingPurpose.length > 0) {
    try {
      const purposes = await inferBlockPurposes(root, blocksNeedingPurpose, router, projectType);
      const byName = new Map(purposes.map((p) => [p.name, p.purpose]));
      enrichedBlocks = blocks.map((b) => (byName.has(b.name) ? { ...b, purpose: byName.get(b.name)! } : b));
    } catch {
      // Structural facts still stand even if the LLM enrichment pass fails — a profile with
      // blank purposes for a few blocks is still usable; a thrown error here shouldn't be.
    }
  }

  const withoutDigest: Omit<RepoProfile, "digestMarkdown"> = {
    workspaceRoot: root,
    generatedAt: new Date().toISOString(),
    cacheKey,
    isGitRepo: gitRepo,
    projectType,
    classification,
    modules: aem.modules,
    aemArtifacts: aem.artifacts,
    aemComponents: aem.components,
    relationships: aem.relationships,
    missingComponents: [],
    authoringSurface,
    blocks: enrichedBlocks,
    tokens,
    conventions,
    ueRegistry,
  };

  return {
    ...withoutDigest,
    digestMarkdown: renderDigestMarkdown(withoutDigest),
  };
}

async function inferBlockPurposes(
  root: string,
  blocks: Array<{ name: string; dir: string; files: string[] }>,
  router: ModelRouter,
  projectType: ProjectType,
): Promise<Array<{ name: string; purpose: string }>> {
  const snippets = blocks.map((b) => {
    const jsFile = b.files.find((f) => f === `${b.name}.js`);
    const source = jsFile ? safeRead(join(root, b.dir, jsFile)) : "";
    return `### ${b.name}\n\`\`\`js\n${source.slice(0, 2000)}\n\`\`\``;
  });

  const projectTypeLabel =
  projectType === "aem"
    ? "Adobe Experience Manager"
    : projectType === "eds"
      ? "Adobe Edge Delivery Services"
      : "Adobe web";

  const result = await router.generateStructured({
    role: "cartographer",
    schema: CartographerEnrichmentSchema,
    schemaName: "CartographerEnrichment",
    system:
      `You are documenting an existing ${projectTypeLabel} codebase for other engineers. ` +
      "For each block's decorate() source shown, write exactly one plain sentence describing what it does. " +
      "Be concrete about the DOM transformation, not generic.",
    prompt: `Blocks:\n\n${snippets.join("\n\n")}`,
  });

  return result.object.blockPurposes;
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}
