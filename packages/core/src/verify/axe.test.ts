import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import { scanAccessibility } from "./axe.js";
import type { UeField } from "../schemas/block-spec.js";

const FIXTURE_ROOT = resolve(import.meta.dirname, "../../../../fixtures/aem-boilerplate-xwalk");

test("fixture is present", () => {
  assert.ok(existsSync(FIXTURE_ROOT), `Expected fixture at ${FIXTURE_ROOT}`);
});

const CARDS_FIELDS: UeField[] = [
  { name: "image", component: "reference", valueType: "string", label: "Image", required: false, options: null },
  { name: "text", component: "richtext", valueType: "string", label: "Text", required: false, options: null },
];

test("scanAccessibility runs a real axe-core pass against the decorated cards block and finds it clean", async () => {
  const result = await scanAccessibility({ workspaceDir: FIXTURE_ROOT, blockName: "cards", ueFields: CARDS_FIELDS });

  assert.equal(result.decorated, true);
  assert.equal(typeof result.violationCount, "number");
  assert.equal(result.violations.length, result.violationCount);
  assert.equal(result.violationCount, 0, JSON.stringify(result.violations, null, 2));
});

// The authoring DOM builder always emits well-formed markup (e.g. every image gets an alt
// attribute, even if empty — which is valid, not a violation) — proving axe-core itself really
// detects real problems, rather than the wiring being a rubber stamp, needs a page we know is
// broken. This tests the same AxeBuilder integration axe.ts uses, directly, against a minimal
// page with a real WCAG violation (an <img> with no alt attribute at all).
test("axe-core (the same integration axe.ts uses) flags a real violation on genuinely broken markup", async () => {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent('<!doctype html><html><body><img src="https://example.com/x.png"></body></html>');
    const results = await new AxeBuilder({ page }).analyze();
    assert.ok(results.violations.some((v) => v.id === "image-alt"), `expected an image-alt violation, got: ${results.violations.map((v) => v.id).join(", ")}`);
  } finally {
    await browser.close();
  }
});
