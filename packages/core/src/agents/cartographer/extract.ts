import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type {
  AuthoringSurface,
  BlockInfo,
  Conventions,
  DesignTokens,
  UeRegistry,
} from "../../schemas/repo-profile.js";
import type { ProjectClassification, ProjectType } from "../../schemas/project-type.js";

/**
 * Deterministic, LLM-free extraction of the facts a Repo Cartographer needs. These are exact
 * parses (file presence, import statements, CSS custom properties, JSON structure) — there is
 * no ambiguity here for a model to resolve, so none of this goes through an agent loop. The
 * agent layer (cartographer.ts) only handles the one genuinely interpretive step: writing a
 * one-line "purpose" for each block and a readable markdown digest.
 */

const KNOWN_HELPERS = [
  "moveInstrumentation",
  "moveAttributes",
  "readBlockConfig",
  "decorateIcons",
  "decorateButtons",
  "decorateMain",
  "createOptimizedPicture",
  "getMetadata",
  "loadFragment",
  "toClassName",
  "toCamelCase",
];

function safeReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function safeReadJson<T>(path: string): T | null {
  const content = safeReadFile(path);
  if (!content) return null;
  try {
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

/**
 * Deterministically identifies the repository's primary project architecture.
 *
 * EDS detection is based on the characteristic document-based project structure.
 * AEM detection is based on AEM Maven configuration and the standard AEM module layout.
 *
 * This intentionally does not use an LLM: project type is a structural fact that can
 * be determined from repository files.
 */
export const DETECTOR_VERSION = "4";

export function detectProjectClassification(root: string): ProjectClassification {
  const packageJson = safeReadJson<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(join(root, "package.json"));

  const pomXml = safeReadFile(join(root, "pom.xml")) ?? "";

  const evidence: ProjectClassification["evidence"] = [];
  let aemScore = 0;
  let edsScore = 0;
  const addEvidence = (input: ProjectClassification["evidence"][number], projectType: "aem" | "eds") => {
    evidence.push(input);
    if (input.polarity === "positive") {
      if (projectType === "aem") aemScore += input.weight;
      else edsScore += input.weight;
    }
  };

  if (/com\.adobe\.aem|aem-sdk-api|aem-api|content-package-maven-plugin|aem-project-archetype/i.test(pomXml)) {
    addEvidence({ signalId: "aem-maven-dependency", category: "build", path: "pom.xml", value: "AEM dependency/plugin", weight: 5, polarity: "positive", explanation: "pom.xml contains a recognized AEM dependency or content-package plugin." }, "aem");
  }
  if (Object.keys({ ...(packageJson?.dependencies ?? {}), ...(packageJson?.devDependencies ?? {}) }).some((dependency) => /@adobe\/aem|aem-sdk|aem-clientlib/i.test(dependency))) {
    addEvidence({ signalId: "aem-package-dependency", category: "build", path: "package.json", value: "AEM package dependency", weight: 3, polarity: "positive", explanation: "package.json contains a recognized AEM package dependency." }, "aem");
  }
  for (const moduleName of ["ui.apps", "ui.content", "ui.frontend", "core", "dispatcher", "all", "it.tests"]) {
    const modulePath = join(root, moduleName);
    if (existsSync(modulePath) && statSync(modulePath).isDirectory()) {
      const hasBuildDescriptor = existsSync(join(modulePath, "pom.xml")) || existsSync(join(modulePath, "package.json"));
      if (hasBuildDescriptor || existsSync(join(root, "pom.xml"))) {
        addEvidence({ signalId: "aem-module", category: "structure", path: moduleName, value: hasBuildDescriptor ? "module with build descriptor" : "module under Maven root", weight: 2, polarity: "positive", explanation: hasBuildDescriptor ? `Recognized AEM module pattern ${moduleName} contains a build descriptor.` : `Recognized AEM module pattern ${moduleName} is declared under a Maven root.` }, "aem");
      }
    }
  }

  const edsMarkers = [
    ["blocks-directory", "blocks"], ["styles-directory", "styles"], ["scripts-directory", "scripts"],
    ["fstab", existsSync(join(root, "fstab.yaml")) ? "fstab.yaml" : "fstab.yml"], ["paths", "paths.json"],
    ["component-definition", "component-definition.json"], ["component-models", "component-models.json"], ["component-filters", "component-filters.json"],
  ] as const;
  for (const [signalId, relativePath] of edsMarkers) {
    if (existsSync(join(root, relativePath))) {
      addEvidence({ signalId, category: "structure", path: relativePath, value: "present", weight: signalId === "blocks-directory" ? 3 : 1, polarity: "positive", explanation: `EDS marker ${relativePath} is present.` }, "eds");
    }
  }

  const minimumScore = 3;
  const hasAem = aemScore >= minimumScore;
  const hasEds = edsScore >= minimumScore;
  const projectType: ProjectType = hasAem && hasEds ? "mixed" : hasAem ? "aem" : hasEds ? "eds" : "unknown";
  const confidence = Math.min(1, Math.max(aemScore, edsScore) / 8);
  const confidenceBand = confidence >= 0.75 ? "high" : confidence >= 0.5 ? "medium" : "low";
  const reason = projectType === "unknown" ? "No architecture reached the minimum evidence threshold." : projectType === "mixed" ? "Both AEM and EDS evidence reached the minimum threshold." : null;
  return { projectType, aemScore, edsScore, confidence, confidenceBand, evidence, reason, detectorVersion: DETECTOR_VERSION };
}

export function detectProjectType(root: string): ProjectType {
  return detectProjectClassification(root).projectType;
}

export function isGitRepo(root: string): boolean {
  return existsSync(join(root, ".git"));
}

/** Content hash over the repository files that actually affect the profile. */
export function computeCacheKey(root: string): string {
  const hash = createHash("sha256");
  hash.update(`blocksmith-cartographer-detector:${DETECTOR_VERSION}`);
  const relevantDirs = [
  "blocks",
  "styles",
  "models",
  "core",
  "ui.apps",
  "ui.content",
  "ui.frontend",
  "dispatcher",
  "all",
  "it.tests",
];

const relevantFiles = [
  "component-definition.json",
  "component-models.json",
  "component-filters.json",
  "package.json",
  "pom.xml",
  "settings.xml",
  "fstab.yaml",
  "fstab.yml",
  "paths.json",
];

  for (const dir of relevantDirs) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    hashDirRecursive(abs, root, hash);
  }
  for (const file of relevantFiles) {
    const abs = join(root, file);
    const content = safeReadFile(abs);
    if (content) {
      hash.update(file);
      hash.update(content);
    }
  }
  return hash.digest("hex");
}

function hashDirRecursive(dir: string, root: string, hash: ReturnType<typeof createHash>) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      hashDirRecursive(abs, root, hash);
    } else {
      hash.update(abs.slice(root.length + 1).replaceAll("\\", "/"));
      const content = safeReadFile(abs);
      if (content) hash.update(content);
    }
  }
}

/**
 * Detects whether the repo has Universal Editor wiring, and if so, whether it's authored as a
 * single hand-edited root JSON (modelShape 'monolithic') or generated from fragments via a
 * build:json-style npm script (modelShape 'fragments') — the shape aem-boilerplate-xwalk uses,
 * where each block ships its own _<name>.json picked up by a glob spread in models/_component-*.json.
 */
export function detectAuthoringSurface(root: string): AuthoringSurface {
  const rootFiles = {
    componentDefinition: existsSync(join(root, "component-definition.json")) ? "component-definition.json" : null,
    componentModels: existsSync(join(root, "component-models.json")) ? "component-models.json" : null,
    componentFilters: existsSync(join(root, "component-filters.json")) ? "component-filters.json" : null,
  };

  const hasAnyRootFile = Object.values(rootFiles).some(Boolean);
  if (!hasAnyRootFile) {
    return {
      hasUniversalEditor: false,
      modelShape: "none",
      fragmentsDir: null,
      buildJsonCommand: null,
      rootFiles,
    };
  }

  const pkg = safeReadJson<{ scripts?: Record<string, string> }>(join(root, "package.json"));
  const buildJsonEntry = Object.entries(pkg?.scripts ?? {}).find(([name]) => name === "build:json" || name.startsWith("build:json:"));
  const fragmentsDirCandidate = "models";
  const hasFragmentsDir = existsSync(join(root, fragmentsDirCandidate));

  return {
    hasUniversalEditor: true,
    modelShape: hasFragmentsDir && buildJsonEntry ? "fragments" : "monolithic",
    fragmentsDir: hasFragmentsDir ? fragmentsDirCandidate : null,
    buildJsonCommand: buildJsonEntry ? "build:json" : null,
    rootFiles,
  };
}

interface UeFragmentDefinition {
  id?: string;
  plugins?: { xwalk?: { page?: { resourceType?: string; template?: { model?: string } } } };
}

/**
 * Reads a block's own _<name>.json fragment (aem-boilerplate-xwalk convention) for the UE model
 * bound to the block itself — the definitions entry whose resourceType is ".../block/v1/block"
 * (as opposed to ".../block/v1/block/item", which describes repeatable child items, e.g. "card"
 * within "cards"). A pure-container block like cards has no block-level model — it only defines
 * fields on its item — so this correctly returns null in that case rather than the item's model id.
 */
function readBlockUeModelId(blockDir: string, blockName: string): string | null {
  const fragmentPath = join(blockDir, `_${blockName}.json`);
  const fragment = safeReadJson<{ definitions?: UeFragmentDefinition[] }>(fragmentPath);
  if (!fragment) return null;
  const blockDefinition = fragment.definitions?.find((d) => d.plugins?.xwalk?.page?.resourceType?.endsWith("/block/v1/block"));
  return blockDefinition?.plugins?.xwalk?.page?.template?.model ?? null;
}

function extractImports(source: string): { names: string[]; from: string | null } {
  const names: string[] = [];
  let from: string | null = null;
  const importRegex = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(source)) !== null) {
    const imported = match[1] ?? "";
    const path = match[2] ?? "";
    for (const raw of imported.split(",")) {
      const name = raw.trim();
      if (name) names.push(name);
    }
    if (path.includes("scripts/")) from = path;
  }
  return { names, from };
}

function extractVariantsFromCss(css: string, blockName: string): string[] {
  // Look for `.blockname.variant` compound selectors — a heuristic for block-option classes.
  const variantRegex = new RegExp(`\\.${blockName}\\.([a-z0-9-]+)`, "g");
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = variantRegex.exec(css)) !== null) {
    if (match[1]) found.add(match[1]);
  }
  return [...found];
}

export function scanBlocks(root: string): BlockInfo[] {
  const blocksDir = join(root, "blocks");
  if (!existsSync(blocksDir)) return [];

  const blockNames = readdirSync(blocksDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  return blockNames.map((name) => {
    const dir = join(blocksDir, name);
    const files = readdirSync(dir).sort();

    const jsFile = files.find((f) => f === `${name}.js`);
    const cssFile = files.find((f) => f === `${name}.css`);
    const jsSource = jsFile ? safeReadFile(join(dir, jsFile)) ?? "" : "";
    const cssSource = cssFile ? safeReadFile(join(dir, cssFile)) ?? "" : "";

    const { names: importedNames, from } = extractImports(jsSource);
    const helpersUsed = importedNames.filter((n) => KNOWN_HELPERS.includes(n));

    const readmeFile = files.find((f) => f.toLowerCase() === "readme.md");
    const readmeContent = readmeFile ? safeReadFile(join(dir, readmeFile)) : null;

    return {
      name,
      dir: `blocks/${name}`,
      files,
      purpose: readmeContent ? readmeContent.split("\n").find((l) => l.trim().length > 0)?.replace(/^#+\s*/, "") ?? "" : "",
      helpersUsed,
      helpersImportedFrom: from,
      variants: extractVariantsFromCss(cssSource, name),
      ueModelId: readBlockUeModelId(dir, name),
      hasUeJson: existsSync(join(dir, `_${name}.json`)),
      hasReadme: Boolean(readmeFile),
    };
  });
}

const COLOR_HINT = /color/i;
const FONT_FAMILY_HINT = /font-family/i;
const FONT_SIZE_HINT = /font-size/i;
const SPACING_HINT = /(spacing|gap|margin|padding|width|height|nav-height)/i;

export function parseTokens(root: string): DesignTokens {
  const tokensFile = "styles/styles.css";
  const css = safeReadFile(join(root, tokensFile)) ?? "";

  if (css === null) {
  return {
    colors: {},
    fonts: {},
    fontSizes: {},
    spacing: {},
    other: {},
    breakpoints: [],
    tokensFile,
  };
}

  const colors: Record<string, string> = {};
  const fonts: Record<string, string> = {};
  const fontSizes: Record<string, string> = {};
  const spacing: Record<string, string> = {};
  const other: Record<string, string> = {};

  // Only the top-level :root block, not nested @media :root overrides — those become breakpoints below.
  const rootBlockMatch = css.match(/:root\s*\{([^}]*)\}/);
  if (rootBlockMatch?.[1] !== undefined) {
    const rootBlockBody = rootBlockMatch[1];
    const declRegex = /--([a-z0-9-]+)\s*:\s*([^;]+);/gi;
    let match: RegExpExecArray | null;
    while ((match = declRegex.exec(rootBlockBody)) !== null) {
      const name = match[1] ?? "";
      const rawValue = match[2] ?? "";
      const key = `--${name}`;
      const value = rawValue.trim();
      if (COLOR_HINT.test(name)) colors[key] = value;
      else if (FONT_FAMILY_HINT.test(name)) fonts[key] = value;
      else if (FONT_SIZE_HINT.test(name)) fontSizes[key] = value;
      else if (SPACING_HINT.test(name)) spacing[key] = value;
      else other[key] = value;
    }
  }

  const breakpoints: DesignTokens["breakpoints"] = [];
  const mediaRegex = /@media\s*\(([^)]+)\)\s*\{\s*:root/g;
  let mediaMatch: RegExpExecArray | null;
  while ((mediaMatch = mediaRegex.exec(css)) !== null) {
    const condition = (mediaMatch[1] ?? "").trim();
    breakpoints.push({
      description: condition.includes(">=") || condition.includes("min-width") ? "wider viewport override" : "narrower viewport override",
      mediaQuery: `(${condition})`,
    });
  }

  return { colors, fonts, fontSizes, spacing, other, breakpoints, tokensFile };
}

export function detectConventions(root: string): Conventions {
  const pkg = safeReadJson<{ scripts?: Record<string, string>; devDependencies?: Record<string, string> }>(join(root, "package.json"));

  const eslintrc = safeReadFile(join(root, ".eslintrc.js")) ?? safeReadFile(join(root, ".eslintrc.json"));
  const jsLinter = eslintrc?.includes("airbnb") ? "eslint-config-airbnb-base" : eslintrc?.includes("xwalk") ? "eslint-plugin-xwalk" : null;

  const stylelintrc = safeReadJson<{ extends?: string | string[] }>(join(root, ".stylelintrc.json"));
  const cssLinter = stylelintrc?.extends
    ? Array.isArray(stylelintrc.extends)
      ? stylelintrc.extends.join(", ")
      : stylelintrc.extends
    : null;

  const lintCommand = pkg?.scripts?.lint ? "lint" : null;

  // Sample an existing block's JS to infer quote/semicolon style rather than trusting lint config alone.
  const sampleBlock = existsSync(join(root, "blocks"))
    ? readdirSync(join(root, "blocks"), { withFileTypes: true }).find((e) => e.isDirectory())?.name
    : null;
  const sample = sampleBlock ? safeReadFile(join(root, "blocks", sampleBlock, `${sampleBlock}.js`)) ?? "" : "";
  const singleQuoteCount = (sample.match(/'/g) ?? []).length;
  const doubleQuoteCount = (sample.match(/"/g) ?? []).length;

  const blocksDir = join(root, "blocks");
  const blocksHaveReadme = existsSync(blocksDir)
    ? readdirSync(blocksDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .some((e) => existsSync(join(blocksDir, e.name, "README.md")))
    : false;

  return {
    jsLinter,
    cssLinter,
    lintCommand,
    quoteStyle: singleQuoteCount >= doubleQuoteCount ? "single" : "double",
    semicolons: sample.trimEnd().split("\n").some((l) => l.trim().endsWith(";")),
    blocksHaveReadme,
  };
}

export function parseUeRegistry(root: string, authoringSurface: AuthoringSurface): UeRegistry | null {
  if (!authoringSurface.hasUniversalEditor || !authoringSurface.rootFiles.componentDefinition) return null;

  const definition = safeReadJson<{ groups?: Array<{ id: string; title: string; components?: Array<{ id: string }> }> }>(
    join(root, authoringSurface.rootFiles.componentDefinition),
  );
  const filters = authoringSurface.rootFiles.componentFilters
    ? safeReadJson<Array<{ id: string; components: string[] }>>(join(root, authoringSurface.rootFiles.componentFilters))
    : null;

  return {
    groups: (definition?.groups ?? []).map((g) => ({
      id: g.id,
      title: g.title,
      componentIds: (g.components ?? []).map((c) => c.id),
    })),
    filters: filters ?? [],
  };
}

export function statOrNull(path: string) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}
