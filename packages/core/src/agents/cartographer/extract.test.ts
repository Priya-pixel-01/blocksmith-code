import { test } from "node:test";
import assert from "node:assert/strict";
// import { existsSync } from "node:fs";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  isGitRepo,
  computeCacheKey,
  detectProjectClassification,
  detectProjectType,
  detectAuthoringSurface,
  scanBlocks,
  parseTokens,
  detectConventions,
  parseUeRegistry,
} from "./extract.js";
import { extractAemRepository } from "./aem-extract.js";

// packages/core/src/agents/cartographer -> repo root is four levels up
const FIXTURE_ROOT = resolve(import.meta.dirname, "../../../../../fixtures/aem-boilerplate-xwalk");
const AEM_FIXTURE_ROOT = resolve(import.meta.dirname, "../../../../../fixtures/aem-project",);
const UNKNOWN_FIXTURE_ROOT = resolve(import.meta.dirname, "../../../../../fixtures/empty-project",);

test("detectProjectType identifies aem-boilerplate-xwalk as EDS", () => {
  assert.equal(detectProjectType(FIXTURE_ROOT), "eds");
});

test("detectProjectType identifies an AEM Maven project as AEM", () => {
  assert.equal(detectProjectType(AEM_FIXTURE_ROOT), "aem");
});

test("detectProjectType returns unknown when no EDS or AEM signals are present", () => {
  assert.equal(detectProjectType(UNKNOWN_FIXTURE_ROOT), "unknown");
});

test("detectProjectType identifies a traditional AEM project", () => {
  const root = resolve(tmpdir(), `cartographer-aem-${Date.now()}`);

  mkdirSync(resolve(root, "core"), { recursive: true });
  mkdirSync(resolve(root, "ui.apps"), { recursive: true });
  writeFileSync(resolve(root, "pom.xml"), "<project></project>");

  try {
    assert.equal(detectProjectType(root), "aem");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectProjectType returns unknown when no project signals are present", () => {
  const root = resolve(tmpdir(), `cartographer-unknown-${Date.now()}`);

  mkdirSync(root, { recursive: true });

  try {
    assert.equal(detectProjectType(root), "unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectProjectClassification reports AEM evidence and confidence", () => {
  const root = resolve(tmpdir(), `cartographer-aem-classification-${Date.now()}`);
  mkdirSync(resolve(root, "ui.apps"), { recursive: true });
  writeFileSync(resolve(root, "pom.xml"), "<dependency>com.adobe.aem:aem-sdk-api</dependency>");

  try {
    const classification = detectProjectClassification(root);
    assert.equal(classification.projectType, "aem");
    assert.equal(classification.confidenceBand, "high");
    assert.ok(classification.evidence.some((item) => item.signalId === "aem-maven-dependency"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectProjectClassification reports mixed AEM and EDS evidence", () => {
  const root = resolve(tmpdir(), `cartographer-mixed-classification-${Date.now()}`);
  mkdirSync(resolve(root, "blocks"), { recursive: true });
  mkdirSync(resolve(root, "ui.apps"), { recursive: true });
  writeFileSync(resolve(root, "pom.xml"), "<dependency>com.adobe.aem:aem-sdk-api</dependency>");

  try {
    const classification = detectProjectClassification(root);
    assert.equal(classification.projectType, "mixed");
    assert.match(classification.reason ?? "", /Both AEM and EDS/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extractAemRepository discovers repository-derived modules and component relationships", () => {
  const root = resolve(tmpdir(), `cartographer-aem-profile-${Date.now()}`);
  const componentRoot = resolve(root, "content-module", "src", "main", "components", "hero");
  mkdirSync(resolve(root, "content-module"), { recursive: true });
  mkdirSync(resolve(componentRoot, "_cq_dialog"), { recursive: true });
  writeFileSync(resolve(root, "content-module", "pom.xml"), "<project><artifactId>content-module</artifactId></project>");
  writeFileSync(resolve(componentRoot, ".content.xml"), "<jcr:root sling:resourceType=\"example/components/hero\" />");
  writeFileSync(resolve(componentRoot, "hero.html"), "<h1>${properties.title}</h1>");
  writeFileSync(resolve(componentRoot, "_cq_dialog", ".content.xml"), "<jcr:root />");

  try {
    const extraction = extractAemRepository(root);
    assert.equal(extraction.modules[0]?.id, "content-module");
    assert.equal(extraction.components[0]?.name, "hero");
    assert.deepEqual(extraction.components[0]?.dialogPaths, ["content-module/src/main/components/hero/_cq_dialog/.content.xml"]);
    assert.deepEqual(extraction.components[0]?.htlPaths, ["content-module/src/main/components/hero/hero.html"]);
    assert.equal(extraction.components[0]?.resourceType, "example/components/hero");
    assert.ok(extraction.relationships.some((relationship) => relationship.type === "component-has-htl"));
    assert.ok(extraction.relationships.every((relationship) => relationship.detectorVersion === "1"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extractAemRepository infers component resource type when metadata only declares a supertype", () => {
  const root = resolve(tmpdir(), `cartographer-aem-resource-type-${Date.now()}`);
  const componentRoot = resolve(root, "ui.apps", "src", "main", "content", "jcr_root", "apps", "wknd", "components", "subscribe-button");
  mkdirSync(componentRoot, { recursive: true });
  mkdirSync(resolve(root, "ui.frontend", "src", "main", "webpack", "components", "subscribe-button"), { recursive: true });
  mkdirSync(resolve(root, "core", "src", "main", "java", "com", "wknd", "models", "impl"), { recursive: true });
  writeFileSync(resolve(root, "ui.apps", "pom.xml"), "<project><artifactId>ui.apps</artifactId></project>");
  writeFileSync(resolve(root, "ui.frontend", "pom.xml"), "<project><artifactId>ui.frontend</artifactId></project>");
  writeFileSync(resolve(root, "core", "pom.xml"), "<project><artifactId>core</artifactId></project>");
  writeFileSync(resolve(componentRoot, ".content.xml"), '<jcr:root sling:resourceSuperType="wknd/components/button" />');
  writeFileSync(resolve(root, "ui.frontend", "src", "main", "webpack", "components", "subscribe-button", "subscribe-button.scss"), ".subscribe-button {}\n");
  writeFileSync(resolve(root, "core", "src", "main", "java", "com", "wknd", "models", "SubscribeButtonModel.java"), "class SubscribeButtonModel {}\n");
  writeFileSync(resolve(root, "core", "src", "main", "java", "com", "wknd", "models", "impl", "SubscribeButtonModelImpl.java"), "class SubscribeButtonModelImpl {}\n");
  try {
    const extraction = extractAemRepository(root);
    assert.equal(extraction.components[0]?.resourceType, "wknd/components/subscribe-button");
    assert.deepEqual(extraction.components[0]?.frontendAssets, ["ui.frontend/src/main/webpack/components/subscribe-button/subscribe-button.scss"]);
    assert.deepEqual(extraction.components[0]?.backendTypes, [
      "core/src/main/java/com/wknd/models/SubscribeButtonModel.java",
      "core/src/main/java/com/wknd/models/impl/SubscribeButtonModelImpl.java",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extractAemRepository infers a component resource type from its apps path", () => {
  const root = resolve(tmpdir(), `cartographer-aem-resource-type-${Date.now()}`);
  const componentRoot = resolve(root, "ui.apps", "src", "main", "content", "jcr_root", "apps", "wknd", "components", "subscribe-button");
  mkdirSync(componentRoot, { recursive: true });
  writeFileSync(resolve(root, "ui.apps", "pom.xml"), "<project><artifactId>ui.apps</artifactId></project>");
  writeFileSync(resolve(componentRoot, ".content.xml"), '<jcr:root sling:resourceSuperType="wknd/components/button" />');
  writeFileSync(resolve(componentRoot, "subscribe-button.html"), "<a>Subscribe</a>");

  try {
    const extraction = extractAemRepository(root);
    assert.equal(extraction.components[0]?.resourceType, "wknd/components/subscribe-button");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixture is present", () => {
  assert.ok(existsSync(FIXTURE_ROOT), `Expected fixture at ${FIXTURE_ROOT} — run: git clone https://github.com/adobe-rnd/aem-boilerplate-xwalk.git fixtures/aem-boilerplate-xwalk`);
});

test("detectProjectType identifies aem-boilerplate-xwalk as EDS", () => {
  assert.equal(detectProjectType(FIXTURE_ROOT), "eds");
});

test("isGitRepo detects the cloned fixture as a git repo", () => {
  assert.equal(isGitRepo(FIXTURE_ROOT), true);
});

test("computeCacheKey hashes authoritative repository content", () => {
  const key = computeCacheKey(FIXTURE_ROOT);
  assert.match(key, /^[0-9a-f]{64}$/);
});

test("computeCacheKey changes for relevant files but ignores unrelated files", () => {
  const root = resolve(tmpdir(), `cartographer-cache-${Date.now()}`);
  mkdirSync(resolve(root, "blocks", "hero"), { recursive: true });
  writeFileSync(resolve(root, "blocks", "hero", "hero.js"), "export default function decorate() {}\n");

  try {
    const initial = computeCacheKey(root);
    writeFileSync(resolve(root, "notes.txt"), "unrelated\n");
    assert.equal(computeCacheKey(root), initial);
    writeFileSync(resolve(root, "blocks", "hero", "hero.js"), "export default function decorate() { return true; }\n");
    assert.notEqual(computeCacheKey(root), initial);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectAuthoringSurface finds the xwalk Universal Editor fragment shape", () => {
  const surface = detectAuthoringSurface(FIXTURE_ROOT);
  assert.equal(surface.hasUniversalEditor, true);
  assert.equal(surface.modelShape, "fragments");
  assert.equal(surface.fragmentsDir, "models");
  assert.equal(surface.buildJsonCommand, "build:json");
  assert.equal(surface.rootFiles.componentDefinition, "component-definition.json");
  assert.equal(surface.rootFiles.componentModels, "component-models.json");
  assert.equal(surface.rootFiles.componentFilters, "component-filters.json");
});

test("scanBlocks lists every known block in aem-boilerplate-xwalk", () => {
  const blocks = scanBlocks(FIXTURE_ROOT);
  const names = blocks.map((b) => b.name).sort();
  assert.deepEqual(names, ["cards", "columns", "footer", "fragment", "header", "hero"]);
});

test("scanBlocks detects moveInstrumentation usage and UE json on cards", () => {
  const blocks = scanBlocks(FIXTURE_ROOT);
  const cards = blocks.find((b) => b.name === "cards");
  assert.ok(cards);
  assert.ok(cards.helpersUsed.includes("moveInstrumentation"), `expected moveInstrumentation, got ${JSON.stringify(cards.helpersUsed)}`);
  assert.equal(cards.hasUeJson, true);
  // cards is a pure container in _cards.json — its block-level definition carries no
  // template.model, only its repeatable "card" item does — so this is correctly null,
  // not the item model's id.
  assert.equal(cards.ueModelId, null);
});

test("scanBlocks detects the header block imports loadFragment from the fragment block, not scripts/", () => {
  const blocks = scanBlocks(FIXTURE_ROOT);
  const header = blocks.find((b) => b.name === "header");
  assert.ok(header);
  assert.ok(header.helpersUsed.includes("getMetadata"));
});

test("scanBlocks detects hero has no decorate logic but does have UE wiring", () => {
  const blocks = scanBlocks(FIXTURE_ROOT);
  const hero = blocks.find((b) => b.name === "hero");
  assert.ok(hero);
  assert.equal(hero.hasUeJson, true);
  assert.equal(hero.ueModelId, "hero");
});

test("parseTokens extracts real design tokens and breakpoints from styles.css", () => {
  const tokens = parseTokens(FIXTURE_ROOT);
  assert.equal(tokens.colors["--link-color"], "#3b63fb");
  assert.equal(tokens.colors["--background-color"], "white");
  assert.ok(tokens.fonts["--body-font-family"]);
  assert.ok(tokens.fontSizes["--heading-font-size-xxl"]);
  assert.ok(tokens.spacing["--nav-height"]);
  assert.ok(
    tokens.breakpoints.some((b) => b.mediaQuery.includes("900px")),
    `expected a 900px breakpoint, got ${JSON.stringify(tokens.breakpoints)}`,
  );
});

test("detectConventions finds the project's real lint setup and quote style", () => {
  const conventions = detectConventions(FIXTURE_ROOT);
  assert.equal(conventions.jsLinter, "eslint-config-airbnb-base");
  assert.equal(conventions.lintCommand, "lint");
  assert.equal(conventions.quoteStyle, "single");
  assert.equal(conventions.semicolons, true);
});

test("parseUeRegistry reads the real component-definition.json groups and component-filters.json", () => {
  const surface = detectAuthoringSurface(FIXTURE_ROOT);
  const registry = parseUeRegistry(FIXTURE_ROOT, surface);
  assert.ok(registry);
  const groupIds = registry.groups.map((g) => g.id).sort();
  assert.ok(groupIds.includes("blocks"), `expected a "blocks" group, got ${JSON.stringify(groupIds)}`);
  const blocksGroup = registry.groups.find((g) => g.id === "blocks");
  assert.ok(blocksGroup?.componentIds.includes("hero"));
  assert.ok(blocksGroup?.componentIds.includes("cards"));
  assert.ok(registry.filters.some((f) => f.id === "section" && f.components.includes("cards")));
});
