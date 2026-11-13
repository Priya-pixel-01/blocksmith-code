import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ModelRole } from "../llm/config.js";
import type { JobEvent } from "../schemas/job.js";
import type { RepoProfile } from "../schemas/repo-profile.js";
import { resolveInSandbox } from "../tools/sandbox.js";

const MAX_TRACE_ARTIFACT_BYTES = 128 * 1024;
const MAX_TRACE_ARTIFACT_TOTAL_BYTES = 1024 * 1024;

export interface AgentTraceJob {
  id: string;
  batchId: string;
  workspaceId: string;
  sourceKind: "figma" | "image" | "pdf";
  sourceRef: string;
  implementationMode: "properties" | "sling_model" | null;
}

export type AgentTraceModels = Record<ModelRole, string>;

export function agentTracePath(scratchDir: string, jobId: string): string {
  if (!/^job_[a-zA-Z0-9_-]+$/.test(jobId)) throw new Error("Invalid job id for trace path");
  return resolve(scratchDir, "agent-traces", `${jobId}.jsonl`);
}

function roleForAgent(agent: string | null): ModelRole | null {
  switch (agent) {
    case "cartographer": return "cartographer";
    case "interpreter":
    case "aem-interpreter": return "interpreter";
    case "reuse": return "reuse";
    case "planner":
    case "aem-planner": return "planner";
    case "builder":
    case "aem-builder": return "builder";
    case "verifier": return "verifier";
    default: return null;
  }
}

function appendJsonLine(path: string, record: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf-8");
}

export function appendAgentTraceRecord(options: {
  scratchDir: string;
  job: AgentTraceJob;
  repoProfile: RepoProfile | null;
  models: AgentTraceModels;
  event: JobEvent;
}): string {
  const path = agentTracePath(options.scratchDir, options.job.id);
  if (!existsSync(path)) {
    appendJsonLine(path, {
      recordType: "trace_header",
      schemaVersion: 1,
      createdAt: options.event.ts,
      job: {
        id: options.job.id,
        batchId: options.job.batchId,
        workspaceId: options.job.workspaceId,
        sourceKind: options.job.sourceKind,
        sourceRef: options.job.sourceRef,
        implementationMode: options.job.implementationMode,
      },
      repository: options.repoProfile ? {
        projectType: options.repoProfile.projectType,
        classification: options.repoProfile.classification,
        modules: options.repoProfile.modules.map(({ id, path, kind }) => ({ id, path, kind })),
        authoringSurface: options.repoProfile.authoringSurface,
        blocks: options.repoProfile.blocks,
        aemComponents: options.repoProfile.aemComponents.map(({ id, name, path, resourceType, frontendAssets, backendTypes }) => ({ id, name, path, resourceType, frontendAssets, backendTypes })),
        aemArtifacts: options.repoProfile.aemArtifacts,
        tokens: options.repoProfile.tokens,
        conventions: options.repoProfile.conventions,
        digestMarkdown: options.repoProfile.digestMarkdown,
      } : null,
      modelIdsByRole: options.models,
      critiqueResponseSchema: "config/aagent-critique-response.schema.json",
      note: "Append-only agent trace. No API keys or binary source images are included.",
    });
  }

  const role = roleForAgent(options.event.agent);
  const executionKind = role
    ? "llm"
    : options.event.agent === "aem-reuse" || options.event.agent === "aem-verifier"
      ? "deterministic"
      : "application";
  appendJsonLine(path, {
    recordType: "event",
    schemaVersion: 1,
    timestamp: options.event.ts,
    type: options.event.type,
    status: options.event.status,
    agent: options.event.agent,
    executionKind,
    modelRole: role,
    modelId: role ? options.models[role] : null,
    message: options.event.message,
    data: options.event.data,
  });
  return path;
}

export function sourceTraceSummary(source: {
  kind: string;
  originGeoRef: string;
  textContent: string | null;
  images: string[];
  structured?: unknown;
}): Record<string, unknown> {
  return {
    kind: source.kind,
    originGeoRef: basename(source.originGeoRef),
    textContent: source.textContent,
    imageCount: source.images.length,
    structured: source.structured ?? null,
  };
}

export function captureTraceArtifacts(workspaceDir: string, paths: string[]): Array<{ path: string; bytes: number; content: string | null; omitted: boolean }> {
  let remainingBytes = MAX_TRACE_ARTIFACT_TOTAL_BYTES;
  const artifacts: Array<{ path: string; bytes: number; content: string | null; omitted: boolean }> = [];
  for (const path of paths) {
    const absolutePath = resolveInSandbox(workspaceDir, path);
    const bytes = statSync(absolutePath).size;
    if (!/\.(java|html|xml|scss|sass|css|js|ts|json|md|txt|ya?ml)$/i.test(path)) {
      artifacts.push({ path, bytes, content: null, omitted: true });
      continue;
    }
    const limit = Math.min(MAX_TRACE_ARTIFACT_BYTES, remainingBytes);
    if (bytes > limit) {
      artifacts.push({ path, bytes, content: null, omitted: true });
      continue;
    }
    artifacts.push({ path, bytes, content: readFileSync(absolutePath, "utf-8"), omitted: false });
    remainingBytes -= bytes;
  }
  return artifacts;
}