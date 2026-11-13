import { readFileSync, writeFileSync } from "node:fs";

/** One entry per agent that talks to an LLM. Kept in sync with README/plan §OpenRouter integration. */
export const MODEL_ROLES = ["cartographer", "interpreter", "reuse", "planner", "builder", "verifier"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export type ModelConfig = Record<ModelRole, string>;

export function loadModelConfig(path: string): ModelConfig {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
  const config = {} as ModelConfig;
  for (const role of MODEL_ROLES) {
    const modelId = raw[role];
    if (!modelId) {
      throw new Error(`Model config at ${path} is missing an entry for role "${role}"`);
    }
    config[role] = modelId;
  }
  return config;
}

export function saveModelConfig(path: string, config: ModelConfig): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}
