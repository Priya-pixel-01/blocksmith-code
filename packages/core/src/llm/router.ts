import { createOpenRouter, type OpenRouterProvider } from "@openrouter/ai-sdk-provider";
import { generateObject, generateText, stepCountIs, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import type { z } from "zod";
import type { ModelConfig, ModelRole } from "./config.js";

export interface AgentLoopResult {
  text: string;
  messages: ModelMessage[];
  stepCount: number;
  costUsd: number | null;
}

export interface ModelRouterOptions {
  apiKey: string;
  models: ModelConfig;
  appName?: string;
}

export interface StructuredCallResult<T> {
  object: T;
  costUsd: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
}

/**
 * Thin wrapper over the OpenRouter provider that:
 *  - resolves a LanguageModel per agent role from config/models.json
 *  - validates configured model ids exist on OpenRouter at startup, so a typo fails loudly
 *  - wraps generateObject with a repair pass for models that don't reliably honour json_schema
 *  - surfaces per-call cost via OpenRouter usage accounting
 */
export class ModelRouter {
  private provider: OpenRouterProvider;

  constructor(private options: ModelRouterOptions) {
    this.provider = createOpenRouter({
      apiKey: options.apiKey,
      appName: options.appName ?? "Blocksmith",
    });
  }

  getModelId(role: ModelRole): string {
    return this.options.models[role];
  }

  getModel(role: ModelRole): LanguageModel {
    const modelId = this.options.models[role];
    return this.provider.chat(modelId, { usage: { include: true } });
  }

  /** Fails loudly if any configured model id isn't a real OpenRouter model — catches config typos before a job runs. */
  async validateModels(): Promise<void> {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    if (!res.ok) {
      throw new Error(`Could not reach OpenRouter model catalog to validate config/models.json (HTTP ${res.status})`);
    }
    const body = (await res.json()) as { data: Array<{ id: string }> };
    const known = new Set(body.data.map((m) => m.id));

    const invalid = Object.entries(this.options.models).filter(([, modelId]) => !known.has(modelId));
    if (invalid.length > 0) {
      const detail = invalid.map(([role, modelId]) => `  - ${role}: "${modelId}"`).join("\n");
      throw new Error(`config/models.json references model ids not found on OpenRouter:\n${detail}`);
    }
  }

  /**
   * Single-shot structured output for a given role, with a one-time repair retry: if the raw
   * response can't be parsed as JSON or fails schema validation, we ask the same model to fix
   * its own output against the validation error before giving up.
   *
   * Pass either `prompt` (plain text) or `messages` (for multi-modal calls, e.g. the Design
   * Interpreter attaching design screenshots) — not both.
   */
  async generateStructured<S extends z.ZodTypeAny>(
    args: {
      role: ModelRole;
      schema: S;
      schemaName?: string;
      schemaDescription?: string;
      system?: string;
    } & ({ prompt: string; messages?: never } | { messages: ModelMessage[]; prompt?: never }),
  ): Promise<StructuredCallResult<z.infer<S>>> {
    const model = this.getModel(args.role);

    const result = await generateObject({
      model,
      schema: args.schema,
      schemaName: args.schemaName,
      schemaDescription: args.schemaDescription,
      system: args.system,
      ...(args.messages ? { messages: args.messages } : { prompt: args.prompt as string }),
      repairText: async ({ text, error }) => {
        const repair = await generateText({
          model,
          system:
            "You previously produced invalid JSON for a strict schema. " +
            "Return ONLY the corrected JSON object — no prose, no code fences.",
          prompt: `Validation error:\n${error.message}\n\nPrevious output:\n${text}`,
        });
        return repair.text;
      },
    });

    const usage = (result.providerMetadata?.openrouter as { usage?: { cost?: number } } | undefined)?.usage;

    return {
      object: result.object,
      costUsd: usage?.cost ?? null,
      promptTokens: result.usage.inputTokens ?? null,
      completionTokens: result.usage.outputTokens ?? null,
    };
  }

  /**
   * Runs a free-running tool loop for a given role (e.g. the Repo Cartographer or Reuse Analyst
   * exploring a codebase): the model calls tools across up to `maxSteps` steps before producing
   * a final text response. Returns the full message history so a caller can follow up with
   * generateStructured({ messages: [...that history, "now respond with JSON"] }) to pull a typed
   * result out of the exploration — this two-call pattern (explore freely, then extract a typed
   * decision) is more reliable across models than asking for tool calls and strict JSON at once.
   */
  async runAgentLoop(args: { role: ModelRole; system: string; prompt: string; tools: ToolSet; maxSteps?: number }): Promise<AgentLoopResult> {
    const model = this.getModel(args.role);

    const result = await generateText({
      model,
      system: args.system,
      prompt: args.prompt,
      tools: args.tools,
      stopWhen: stepCountIs(args.maxSteps ?? 6),
    });

    const usage = (result.providerMetadata?.openrouter as { usage?: { cost?: number } } | undefined)?.usage;

    return {
      text: result.text,
      messages: result.response.messages,
      stepCount: result.steps.length,
      costUsd: usage?.cost ?? null,
    };
  }
}
