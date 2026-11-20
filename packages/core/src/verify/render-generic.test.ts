import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderGenericComponent } from "./render-generic.js";

test("renderGenericComponent opens the selected standalone HTML at the shared responsive widths", async () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "blocksmith-generic-render-"));
  const outDir = join(workspaceDir, "screenshots");
  const componentDir = join(workspaceDir, "src", "components", "hero");
  mkdirSync(componentDir, { recursive: true });
  writeFileSync(join(componentDir, "hero.html"), '<!doctype html><html><head><link rel="stylesheet" href="hero.css"></head><body><main class="hero"><h1>Hello</h1></main><script src="hero.js"></script></body></html>');
  writeFileSync(join(componentDir, "hero.css"), ".hero { color: rgb(20, 40, 60); }");
  writeFileSync(join(componentDir, "hero.js"), "document.documentElement.dataset.ready = 'true';");

  try {
    const result = await renderGenericComponent({
      workspaceDir,
      htmlPath: "src/components/hero/hero.html",
      outDir,
    });

    assert.equal(result.decorated, true);
    assert.equal(result.screenshots.length, 3);
    assert.equal(result.consoleErrors.length, 0, result.consoleErrors.join("; "));
    assert.match(result.decoratedHtml, /data-ready="true"/);
    for (const screenshot of result.screenshots) {
      assert.ok(existsSync(screenshot.path));
      assert.ok(statSync(screenshot.path).size > 500);
    }
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});
