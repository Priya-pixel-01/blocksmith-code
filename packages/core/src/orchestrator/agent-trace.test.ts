import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_ROLES, type ModelConfig } from "../llm/config.js";
import type { JobEvent } from "../schemas/job.js";
import { agentTracePath, appendAgentTraceRecord, captureTraceArtifacts } from "./agent-trace.js";

const models = Object.fromEntries(MODEL_ROLES.map((role) => [role, `test/${role}`])) as ModelConfig;
const job = {
  id: "job_trace_test123",
  batchId: "batch_trace",
  workspaceId: "workspace_trace",
  sourceKind: "image" as const,
  sourceRef: "design.png",
  implementationMode: "sling_model" as const,
};

function event(input: Partial<JobEvent> = {}): JobEvent {
  return {
    jobId: job.id,
    ts: "2026-10-03T12:00:00.000Z",
    type: "agent-message",
    status: null,
    agent: "aem-planner",
    message: "Plan created",
    data: { output: { filesToCreate: ["core/src/main/java/Example.java"] } },
    ...input,
  };
}

test("appendAgentTraceRecord writes a JSONL header and structured agent outputs", () => {
  const scratchDir = mkdtempSync(join(tmpdir(), "blocksmith-agent-trace-"));
  try {
    const firstPath = appendAgentTraceRecord({ scratchDir, job, repoProfile: null, models, event: event() });
    appendAgentTraceRecord({ scratchDir, job, repoProfile: null, models, event: event({ agent: "aem-builder", message: "Generated model files" }) });
    const records = readFileSync(firstPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);

    assert.equal(firstPath, agentTracePath(scratchDir, job.id));
    assert.equal(records.length, 3);
    assert.equal(records[0]?.recordType, "trace_header");
    assert.equal(records[0]?.job.implementationMode, "sling_model");
    assert.equal(records[0]?.modelIdsByRole.planner, "test/planner");
    assert.equal(records[1]?.modelRole, "planner");
    assert.equal(records[1]?.executionKind, "llm");
    assert.deepEqual(records[1]?.data.output.filesToCreate, ["core/src/main/java/Example.java"]);
    assert.equal(records[2]?.modelId, "test/builder");
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test("agentTracePath rejects unsafe job IDs", () => {
  assert.throws(() => agentTracePath("C:/scratch", "../secrets"), /Invalid job id/);
});

test("captureTraceArtifacts includes source text and omits binary assets", () => {
  const workspaceDir = mkdtempSync(join(tmpdir(), "blocksmith-trace-artifacts-"));
  try {
    mkdirSync(join(workspaceDir, "core"), { recursive: true });
    writeFileSync(join(workspaceDir, "core", "Example.java"), "class Example {}\n");
    writeFileSync(join(workspaceDir, "core", "logo.png"), Buffer.from([0, 1, 2, 3]));
    const artifacts = captureTraceArtifacts(workspaceDir, ["core/Example.java", "core/logo.png"]);
    assert.equal(artifacts[0]?.content, "class Example {}\n");
    assert.equal(artifacts[0]?.omitted, false);
    assert.equal(artifacts[1]?.content, null);
    assert.equal(artifacts[1]?.omitted, true);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});