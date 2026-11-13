import { z } from "zod";
import { ProjectClassificationSchema, ProjectTypeSchema } from "./project-type.js";
import { AemComponentSchema, AemModuleSchema, RepositoryRelationshipSchema } from "./aem-profile.js";
import { MissingComponentSchema } from "./component-spec.js";
import type { AemArtifact, AemComponent, AemModule, RepositoryRelationship } from "./aem-profile.js";
import type { MissingComponent } from "./component-spec.js";
export type { ProjectClassification, ProjectType } from "./project-type.js";

/**
 * What the Repo Cartographer produces after reading a target EDS or AEM project once.
 * Cached per workspace and injected into every downstream agent's system prompt
 * so they never have to re-crawl the repo.
 */

export const AuthoringSurfaceSchema = z.object({
  hasUniversalEditor: z.boolean().describe(
    "True if component-definition.json / component-models.json / component-filters.json (or their models/_*.json fragment sources) exist.",
  ),
  modelShape: z
    .enum(["monolithic", "fragments", "none"])
    .describe(
      "monolithic: single root component-models.json etc. are hand-edited. " +
        "fragments: root files are generated via a build:json script (e.g. merge-json-cli) from models/_*.json and per-block _<name>.json files — the Builder must edit the fragment, not the generated root file. " +
        "none: document-based authoring only, no Universal Editor.",
    ),
  fragmentsDir: z.string().nullable().describe("e.g. 'models' — directory holding shared _*.json fragments, if modelShape is 'fragments'."),
  buildJsonCommand: z.string().nullable().describe("npm script that regenerates root JSON from fragments, e.g. 'build:json'."),
  rootFiles: z.object({
    componentDefinition: z.string().nullable(),
    componentModels: z.string().nullable(),
    componentFilters: z.string().nullable(),
  }),
});
export type AuthoringSurface = z.infer<typeof AuthoringSurfaceSchema>;

export const BlockInfoSchema = z.object({
  name: z.string(),
  dir: z.string().describe("Path relative to repo root, e.g. 'blocks/cards'."),
  files: z.array(z.string()).describe("Filenames present in the block directory."),
  purpose: z.string().describe("One-line description of what the block does, inferred from its code."),
  helpersUsed: z.array(z.string()).describe("aem.js / scripts.js helper functions this block imports, e.g. 'moveInstrumentation', 'createOptimizedPicture'."),
  helpersImportedFrom: z.string().nullable().describe("Module path blocks in this repo import shared helpers from, e.g. '../../scripts/scripts.js'."),
  variants: z.array(z.string()).describe("Known block-option class variants, if discoverable from CSS selectors."),
  ueModelId: z.string().nullable().describe("Universal Editor model id wired to this block, if any."),
  hasUeJson: z.boolean().describe("Whether a per-block _<name>.json (or equivalent UE fragment) exists."),
  hasReadme: z.boolean(),
});
export type BlockInfo = z.infer<typeof BlockInfoSchema>;

export const DesignTokensSchema = z.object({
  colors: z.record(z.string(), z.string()).describe("--custom-property name -> value."),
  fonts: z.record(z.string(), z.string()),
  fontSizes: z.record(z.string(), z.string()),
  spacing: z.record(z.string(), z.string()),
  other: z.record(z.string(), z.string()).describe("Any :root custom property not classified above."),
  breakpoints: z.array(
    z.object({
      description: z.string().describe("e.g. 'tablet and up'."),
      mediaQuery: z.string().describe("The exact media query condition used in this repo, e.g. '(width >= 900px)'."),
    }),
  ),
  tokensFile: z.string().describe("Path to the file these were read from, e.g. 'styles/styles.css'."),
});
export type DesignTokens = z.infer<typeof DesignTokensSchema>;

export const ConventionsSchema = z.object({
  jsLinter: z.string().nullable().describe("e.g. 'eslint-config-airbnb-base' or 'eslint-plugin-xwalk'."),
  cssLinter: z.string().nullable().describe("e.g. 'stylelint-config-standard'."),
  lintCommand: z.string().nullable().describe("npm script to run project lint, e.g. 'lint'."),
  quoteStyle: z.enum(["single", "double"]),
  semicolons: z.boolean(),
  blocksHaveReadme: z.boolean(),
});
export type Conventions = z.infer<typeof ConventionsSchema>;

export const UeRegistrySchema = z.object({
  groups: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      componentIds: z.array(z.string()),
    }),
  ),
  filters: z.array(
    z.object({
      id: z.string(),
      components: z.array(z.string()),
    }),
  ),
});
export type UeRegistry = z.infer<typeof UeRegistrySchema>;

export const RepoProfileSchema = z.object({
  workspaceRoot: z.string(),
  generatedAt: z.string().describe("ISO timestamp."),
  cacheKey: z.string().describe("git HEAD sha, or a content hash of repository files relevant to the detected project architecture."),
  isGitRepo: z.boolean(),
  projectType: ProjectTypeSchema,
  classification: ProjectClassificationSchema,
  modules: z.array(AemModuleSchema).default([]),
  aemArtifacts: z.array(z.object({
    kind: z.enum(["htl", "dialog", "content-definition", "component-metadata", "clientlib", "java", "osgi-config", "other"]),
    path: z.string(),
    componentId: z.string().nullable(),
  })).default([]),
  aemComponents: z.array(AemComponentSchema).default([]),
  relationships: z.array(RepositoryRelationshipSchema).default([]),
  missingComponents: z.array(MissingComponentSchema).default([]),
  authoringSurface: AuthoringSurfaceSchema,
  blocks: z.array(BlockInfoSchema),
  tokens: DesignTokensSchema,
  conventions: ConventionsSchema,
  ueRegistry: UeRegistrySchema.nullable(),
  digestMarkdown: z.string().describe("Compact markdown summary injected into downstream agent prompts."),
});
export type RepoProfile = z.infer<typeof RepoProfileSchema>;
export type { AemArtifact, AemComponent, AemModule, MissingComponent, RepositoryRelationship };
