import { test } from "node:test";
import assert from "node:assert/strict";
import { genericDestinationQuestion, normalizeGenericDestination } from "./generic-project.js";

test("generic destination prompt explains the standalone fallback and asks for a repo-relative parent", () => {
  const question = genericDestinationQuestion();
  assert.equal(question.required, true);
  assert.match(question.prompt, /repository-relative parent folder/i);
  assert.match(question.prompt, /not be wired into an unknown framework/i);
});

test("normalizeGenericDestination accepts repository-relative paths and root", () => {
  assert.equal(normalizeGenericDestination("src\\components\\"), "src/components");
  assert.equal(normalizeGenericDestination("."), "");
});

test("normalizeGenericDestination rejects absolute paths and traversal", () => {
  assert.throws(() => normalizeGenericDestination("C:\\projects\\site"), /repository-relative/);
  assert.throws(() => normalizeGenericDestination("../outside"), /cannot contain/);
  assert.throws(() => normalizeGenericDestination("src/../../outside"), /cannot contain/);
  assert.throws(() => normalizeGenericDestination("node_modules/component"), /cannot be inside/);
});
