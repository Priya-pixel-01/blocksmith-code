import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeAemReuse } from "./aem-reuse.js";
import type { AemComponent } from "../schemas/aem-profile.js";

const HERO: AemComponent = {
  id: "ui.apps/src/main/content/jcr_root/apps/site/components/hero",
  name: "hero",
  path: "ui.apps/src/main/content/jcr_root/apps/site/components/hero",
  resourceType: "site/components/hero",
  dialogPaths: ["hero/_cq_dialog/.content.xml"],
  htlPaths: ["hero/hero.html"],
  clientlibPaths: ["hero/clientlibs/.content.xml"],
  configurationPaths: [],
  artifacts: ["hero/.content.xml", "hero/hero.html"],
  frontendAssets: ["hero/clientlibs/site.js"],
  backendTypes: ["core/src/main/java/HeroModel.java"],
  variants: ["image"],
  dependencies: [],
  tests: [],
};

test("AEM reuse identifies an exact component match", () => {
  const result = analyzeAemReuse([HERO], {
    name: "hero",
    resourceType: "site/components/hero",
    dialogPaths: HERO.dialogPaths,
    htlPaths: HERO.htlPaths,
    frontendAssets: HERO.frontendAssets,
    backendTypes: HERO.backendTypes,
    variants: HERO.variants,
  });
  assert.equal(result.decision, "reuse");
  assert.equal(result.targetComponent, HERO.id);
});

test("AEM reuse matches abbreviated artifact names against repository paths", () => {
  const result = analyzeAemReuse([HERO], {
    name: "hero",
    resourceType: "site/components/hero",
    dialogPaths: [".content.xml"],
    htlPaths: ["hero.html"],
    frontendAssets: ["site.js"],
    backendTypes: ["HeroModel.java"],
  });
  assert.equal(result.decision, "reuse");
  assert.equal(result.targetComponent, HERO.id);
});

test("AEM reuse extends an existing component when new functionality is requested", () => {
  const result = analyzeAemReuse([HERO], {
    name: "hero",
    resourceType: "site/components/hero",
    backendTypes: ["core/src/main/java/FunctionalHeroModel.java"],
  });
  assert.equal(result.decision, "extend");
  assert.equal(result.targetComponent, HERO.id);
  assert.ok(result.gaps.some((gap) => gap.includes("backend")));
});

test("AEM reuse detects a matching component that needs modification", () => {
  const result = analyzeAemReuse([HERO], {
    name: "hero",
    resourceType: "site/components/hero",
    dialogPaths: ["hero/_cq_dialog/.content.xml", "hero/_cq_dialog/image.xml"],
  });
  assert.equal(result.decision, "modify");
  assert.ok(result.gaps.some((gap) => gap.includes("dialog")));
});

test("AEM reuse detects frontend and backend implementation differences", () => {
  const result = analyzeAemReuse([HERO], {
    name: "hero",
    resourceType: "site/components/hero",
    frontendAssets: ["hero/clientlibs/alternate.js"],
    backendTypes: ["core/src/main/java/AlternateHeroModel.java"],
  });
  assert.equal(result.decision, "extend");
  assert.ok(result.gaps.some((gap) => gap.includes("frontend")));
  assert.ok(result.gaps.some((gap) => gap.includes("backend")));
});

test("AEM reuse creates a new component when only a related name exists", () => {
  const result = analyzeAemReuse([HERO], {
    name: "hero-banner",
    resourceType: "site/components/hero",
  });
  assert.equal(result.decision, "create");
  assert.equal(result.targetComponent, null);
});

test("AEM reuse creates a component when no candidate exists", () => {
  const result = analyzeAemReuse([HERO], { name: "pricing-table", resourceType: "site/components/pricing-table" });
  assert.equal(result.decision, "create");
  assert.equal(result.targetComponent, null);
});

test("AEM reuse tolerates component inventories from older cached profiles", () => {
  const legacyComponent = { ...HERO } as AemComponent & { dialogPaths?: string[]; htlPaths?: string[]; frontendAssets?: string[]; backendTypes?: string[]; variants?: string[] };
  delete legacyComponent.dialogPaths;
  delete legacyComponent.htlPaths;
  delete legacyComponent.frontendAssets;
  delete legacyComponent.backendTypes;
  delete legacyComponent.variants;

  const result = analyzeAemReuse([legacyComponent as unknown as AemComponent], {
    name: "hero",
    resourceType: "site/components/hero",
    dialogPaths: HERO.dialogPaths,
  });
  assert.equal(result.decision, "modify");
  assert.equal(result.targetComponent, HERO.id);
});

test("AEM exact component identity is reused when the requested implementation already exists", () => {
  const result = analyzeAemReuse([HERO], { name: "hero" });
  assert.equal(result.decision, "reuse");
  assert.equal(result.targetComponent, HERO.id);
});

test("AEM exact component identity is extended when Sling Model behavior is requested but absent", () => {
  const propertiesOnlyHero = { ...HERO, backendTypes: [] };
  const result = analyzeAemReuse([propertiesOnlyHero], { name: "hero", implementationMode: "sling_model" });
  assert.equal(result.decision, "extend");
  assert.equal(result.targetComponent, HERO.id);
  assert.ok(result.gaps.some((gap) => gap.includes("Sling Model")));
});

test("AEM CTA naming variants extend an existing button instead of creating a duplicate", () => {
  const subscribeButton = { ...HERO, id: "wknd/components/subscribe-button", name: "subscribe-button", path: "ui.apps/.../subscribe-button" };
  const result = analyzeAemReuse([subscribeButton], { name: "subscribe-cta" });
  assert.equal(result.decision, "extend");
  assert.equal(result.targetComponent, subscribeButton.id);
});