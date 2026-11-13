import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, cpSync, symlinkSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runLint } from "./lint.js";

const FIXTURE_ROOT = resolve(import.meta.dirname, "../../../../fixtures/aem-boilerplate-xwalk");

test("fixture is present with its own dependencies installed", () => {
  assert.ok(existsSync(FIXTURE_ROOT), `Expected fixture at ${FIXTURE_ROOT}`);
  assert.ok(existsSync(join(FIXTURE_ROOT, "node_modules")), "Run `npm install` inside the fixture so its real lint command works for this test.");
});

test("runLint returns passed:true immediately when the repo has no lint command", async () => {
  const result = await runLint("/nonexistent", null);
  assert.equal(result.passed, true);
  assert.match(result.output, /No lint command/);
});

test("runLint against the real fixture passes clean", async () => {
  const result = await runLint(FIXTURE_ROOT, "lint");
  assert.equal(result.passed, true, result.output);
});

test("runLint fails and captures real eslint/stylelint output when the code is actually broken", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blocksmith-lint-broken-"));
  try {
    // Copy just enough of the fixture to run lint against, symlinking node_modules so eslint/stylelint resolve.
    for (const entry of ["blocks", "styles", "package.json", ".eslintrc.js", ".stylelintrc.json"]) {
      cpSync(join(FIXTURE_ROOT, entry), join(dir, entry), { recursive: true });
    }
    symlinkSync(join(FIXTURE_ROOT, "node_modules"), join(dir, "node_modules"), "dir");

    // Introduce a real lint violation: unused variable (airbnb-base's no-unused-vars).
    appendFileSync(join(dir, "blocks", "cards", "cards.js"), "\nconst thisVariableIsNeverUsed = 42;\n");

    const result = await runLint(dir, "lint");
    assert.equal(result.passed, false);
    assert.match(result.output, /no-unused-vars|thisVariableIsNeverUsed/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
