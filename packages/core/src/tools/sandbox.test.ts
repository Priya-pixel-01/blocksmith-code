import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInSandbox, SandboxViolationError, isWithinAllowlist } from "./sandbox.js";
import { createFsTools } from "./fs.js";

function withTempRoot(fn: (root: string) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "blocksmith-sandbox-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("resolveInSandbox allows a normal relative path", () => {
  withTempRoot((root) => {
    const abs = resolveInSandbox(root, "blocks/cards/cards.js");
    assert.equal(abs, join(root, "blocks/cards/cards.js"));
  });
});

test("resolveInSandbox rejects absolute paths", () => {
  withTempRoot((root) => {
    assert.throws(() => resolveInSandbox(root, "/etc/passwd"), SandboxViolationError);
  });
});

test("resolveInSandbox rejects ../ traversal out of root", () => {
  withTempRoot((root) => {
    assert.throws(() => resolveInSandbox(root, "../../etc/passwd"), SandboxViolationError);
  });
});

test("resolveInSandbox rejects a symlink that escapes root", () => {
  withTempRoot((root) => {
    const outside = mkdtempSync(join(tmpdir(), "blocksmith-outside-"));
    try {
      symlinkSync(outside, join(root, "escape"));
      assert.throws(() => resolveInSandbox(root, "escape/anything.txt"), SandboxViolationError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("resolveInSandbox allows a deeply nested path when neither it nor the root itself exists yet", () => {
  // Regression test: a fresh backup/output directory several levels deep, where nothing on the
  // path — not even `root` — exists on disk yet, previously made the ancestor-walk overshoot
  // past `root` to some unrelated existing grandparent and false-positive as an escape.
  withTempRoot((tmpParent) => {
    const root = join(tmpParent, "does", "not", "exist", "yet");
    const abs = resolveInSandbox(root, "blocks/cards/cards.js");
    assert.equal(abs, join(root, "blocks/cards/cards.js"));
  });
});

test("fs_write tool rejects writes outside the sandbox", async () => {
  await withTempRoot(async (root) => {
    const { fs_write } = createFsTools(root);
    // Real tool-call invocations always come from the AI SDK's own runtime, which supplies a
    // full ToolExecutionOptions; this test calls execute() directly to isolate the sandbox check,
    // so it's typed loosely here rather than constructing a real one.
    const execute = fs_write.execute as (input: { path: string; content: string }) => Promise<unknown>;
    await assert.rejects(() => execute({ path: "../../etc/passwd", content: "pwned" }), SandboxViolationError);
  });
});

test("isWithinAllowlist accepts paths under an allowed dir and rejects others", () => {
  withTempRoot((root) => {
    mkdirSync(join(root, "blocks"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    assert.equal(isWithinAllowlist(root, "blocks/hero/hero.js", ["blocks", "styles"]), true);
    assert.equal(isWithinAllowlist(root, "scripts/aem.js", ["blocks", "styles"]), false);
  });
});
