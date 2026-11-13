import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderBlock } from "./render.js";
import type { UeField } from "../schemas/block-spec.js";

const FIXTURE_ROOT = resolve(import.meta.dirname, "../../../../fixtures/aem-boilerplate-xwalk");

test("fixture is present", () => {
  assert.ok(existsSync(FIXTURE_ROOT), `Expected fixture at ${FIXTURE_ROOT}`);
});

const CARDS_FIELDS: UeField[] = [
  { name: "image", component: "reference", valueType: "string", label: "Image", required: false, options: null },
  { name: "text", component: "richtext", valueType: "string", label: "Text", required: false, options: null },
];

test("renderBlock actually runs the real cards decorate() and screenshots the result at three breakpoints", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "blocksmith-render-"));
  try {
    const result = await renderBlock({ workspaceDir: FIXTURE_ROOT, blockName: "cards", ueFields: CARDS_FIELDS, outDir });

    assert.equal(result.consoleErrors.length, 0, `unexpected console errors: ${result.consoleErrors.join("; ")}`);

    assert.equal(result.screenshots.length, 3);
    for (const shot of result.screenshots) {
      assert.ok(existsSync(shot.path));
      assert.ok(statSync(shot.path).size > 500, `screenshot ${shot.label} looks suspiciously small/blank`);
    }

    assert.equal(result.decorated, true);

    // cards' real decorate() replaces the block's children with a <ul><li> structure — proof the
    // actual module ran (via the real page pipeline, not a mock) against our synthetic DOM.
    assert.ok(result.decoratedHtml.includes("<ul"), "expected cards' decorate() to have produced a <ul>");
    assert.ok(result.decoratedHtml.includes("cards-card-image") || result.decoratedHtml.includes("cards-card-body"));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("renderBlock handles a block with an empty decorate() (hero) without error", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "blocksmith-render-"));
  try {
    const heroFields: UeField[] = [
      { name: "image", component: "reference", valueType: "string", label: "Image", required: false, options: null },
      { name: "text", component: "richtext", valueType: "string", label: "Text", required: false, options: null },
    ];
    const result = await renderBlock({ workspaceDir: FIXTURE_ROOT, blockName: "hero", ueFields: heroFields, outDir });

    assert.equal(result.consoleErrors.length, 0, `unexpected console errors: ${result.consoleErrors.join("; ")}`);
    assert.equal(result.decorated, true);
    assert.equal(result.screenshots.length, 3);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("renderBlock surfaces a missing block's module-load failure as a console error rather than crashing", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "blocksmith-render-"));
  try {
    // aem.js's own loadBlock() catches a failed dynamic import internally and logs it — it still
    // marks the block "loaded" (there's nothing more to wait for), so this should behave exactly
    // like the real framework does with a broken/missing block: no crash, a clear console error.
    const result = await renderBlock({ workspaceDir: FIXTURE_ROOT, blockName: "does-not-exist", ueFields: [], outDir });
    assert.equal(result.decorated, true);
    assert.ok(
      result.consoleErrors.some((e) => /failed to load module/i.test(e)),
      `expected a "failed to load module" console error, got: ${JSON.stringify(result.consoleErrors)}`,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
