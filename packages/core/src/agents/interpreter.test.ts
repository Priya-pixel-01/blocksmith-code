import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { interpretDesign } from "./interpreter.js";
import type { RepoProfile } from "../schemas/repo-profile.js";
import type { SourceArtifact } from "../schemas/source.js";
import type { ModelRouter } from "../llm/router.js";
import type { BlockSpec } from "../schemas/block-spec.js";

const MINIMAL_REPO_PROFILE: RepoProfile = {
  workspaceRoot: "/fake/repo",
  generatedAt: new Date().toISOString(),
  cacheKey: "deadbeef",
  isGitRepo: true,
  projectType: "eds",
  classification: {
    projectType: "eds",
    aemScore: 0,
    edsScore: 8,
    confidence: 1,
    confidenceBand: "high",
    evidence: [],
    reason: null,
    detectorVersion: "1",
  },
  modules: [],
  aemArtifacts: [],
  aemComponents: [],
  relationships: [],
  missingComponents: [],
  authoringSurface: {
    hasUniversalEditor: true,
    modelShape: "fragments",
    fragmentsDir: "models",
    buildJsonCommand: "build:json",
    rootFiles: { componentDefinition: "component-definition.json", componentModels: "component-models.json", componentFilters: "component-filters.json" },
  },
  blocks: [],
  tokens: {
    colors: { "--link-color": "#3b63fb" },
    fonts: {},
    fontSizes: {},
    spacing: {},
    other: {},
    breakpoints: [{ description: "wider viewport override", mediaQuery: "(width >= 900px)" }],
    tokensFile: "styles/styles.css",
  },
  conventions: { jsLinter: "eslint-config-airbnb-base", cssLinter: null, lintCommand: "lint", quoteStyle: "single", semicolons: true, blocksHaveReadme: false },
  ueRegistry: null,
  digestMarkdown: "# fake digest",
};

const FAKE_BLOCK_SPEC: BlockSpec = {
  blockNameCandidate: "testimonial-carousel",
  intent: "A rotating set of customer testimonials.",
  ueFields: [{ name: "quote", component: "richtext", valueType: "string", label: "Quote", required: true, options: null }],
  domContract: "A `<ul>` of `<li>` testimonial cards.",
  responsive: [{ breakpoint: "(width >= 900px)", behavior: "shows 3 cards instead of 1" }],
  variants: [],
  tokenMapping: [{ designValue: "#3b63fb", mappedToken: "--link-color", isNew: false }],
  a11y: ["carousel controls must be keyboard-operable"],
  openQuestions: [],
};

test("interpretDesign passes the repo digest, extracted text, and image parts to the model, and returns its object", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blocksmith-interpreter-"));
  try {
    const imagePath = join(dir, "source.png");
    await sharp({ create: { width: 100, height: 60, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toFile(imagePath);

    const artifact: SourceArtifact = {
      kind: "image",
      originGeoRef: imagePath,
      textContent: null,
      images: [imagePath],
      structured: null,
    };

    let capturedArgs: unknown;
    const stubRouter = {
      generateStructured: async (args: unknown) => {
        capturedArgs = args;
        return { object: FAKE_BLOCK_SPEC, costUsd: 0.001, promptTokens: 10, completionTokens: 5 };
      },
    } as unknown as ModelRouter;

    const { blockSpec: spec, costUsd } = await interpretDesign({ artifact, repoProfile: MINIMAL_REPO_PROFILE, router: stubRouter });

    assert.deepEqual(spec, FAKE_BLOCK_SPEC);
    assert.equal(costUsd, 0.001);

    const args = capturedArgs as { role: string; system: string; messages: Array<{ role: string; content: Array<{ type: string }> }> };
    assert.equal(args.role, "interpreter");
    assert.ok(args.system.includes("Design Interpreter"));
    assert.equal(args.messages.length, 1);
    assert.equal(args.messages[0]!.role, "user");

    const parts = args.messages[0]!.content;
    assert.equal(parts[0]!.type, "text");
    assert.equal(parts[1]!.type, "file");

    const textPart = parts[0] as { type: "text"; text: string };
    assert.ok(textPart.text.includes("fake digest"), "should include the repo profile digest");
    assert.ok(textPart.text.includes("(width >= 900px)"), "should list the repo's real breakpoints");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("interpretDesign includes BRD text content and pruned Figma structure when present", async () => {
  const artifact: SourceArtifact = {
    kind: "pdf",
    originGeoRef: "brd.pdf",
    textContent: "The homepage must show a hero banner with a headline and CTA button.",
    images: [],
    structured: null,
  };

  let capturedArgs: unknown;
  const stubRouter = {
    generateStructured: async (args: unknown) => {
      capturedArgs = args;
      return { object: FAKE_BLOCK_SPEC, costUsd: null, promptTokens: null, completionTokens: null };
    },
  } as unknown as ModelRouter;

  const { costUsd } = await interpretDesign({ artifact, repoProfile: MINIMAL_REPO_PROFILE, router: stubRouter });
  assert.equal(costUsd, null, "costUsd should propagate as null when the router reports no usage data");

  const args = capturedArgs as { messages: Array<{ content: Array<{ type: string; text?: string }> }> };
  const textPart = args.messages[0]!.content[0] as { type: "text"; text: string };
  assert.ok(textPart.text.includes("hero banner with a headline and CTA button"));
});
