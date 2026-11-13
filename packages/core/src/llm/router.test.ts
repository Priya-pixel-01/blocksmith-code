import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelRouter } from "./router.js";
import type { ModelConfig } from "./config.js";

const validConfig: ModelConfig = {
  cartographer: "openai/gpt-4o-mini",
  interpreter: "anthropic/claude-haiku-4.5",
  reuse: "anthropic/claude-haiku-4.5",
  planner: "anthropic/claude-haiku-4.5",
  builder: "anthropic/claude-haiku-4.5",
  verifier: "anthropic/claude-haiku-4.5",
};

const catalogResponseFor = (ids: string[]) =>
  new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/**
 * validateModels() calls the live OpenRouter catalog over HTTPS, which this sandbox's egress
 * proxy blocks (same restriction as figma.com/aem.live). Stubbing global.fetch keeps the test
 * deterministic and independent of wherever it runs, while still exercising the real matching
 * and error-formatting logic in router.ts.
 */
function withStubbedFetch<T>(response: Response | (() => Response), fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => (typeof response === "function" ? response() : response)) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test("validateModels passes when every configured model id is in the catalog", async () => {
  await withStubbedFetch(catalogResponseFor(Object.values(validConfig)), async () => {
    const router = new ModelRouter({ apiKey: "test-key", models: validConfig });
    await router.validateModels();
  });
});

test("validateModels throws naming the role and model id for an unknown model", async () => {
  const badConfig = { ...validConfig, cartographer: "openai/definitely-not-a-real-model-xyz" };
  await withStubbedFetch(catalogResponseFor(Object.values(validConfig)), async () => {
    const router = new ModelRouter({ apiKey: "test-key", models: badConfig });
    await assert.rejects(() => router.validateModels(), /cartographer.*openai\/definitely-not-a-real-model-xyz/s);
  });
});

test("validateModels surfaces a clear error when the catalog endpoint is unreachable", async () => {
  await withStubbedFetch(new Response("", { status: 403 }), async () => {
    const router = new ModelRouter({ apiKey: "test-key", models: validConfig });
    await assert.rejects(() => router.validateModels(), /HTTP 403/);
  });
});
