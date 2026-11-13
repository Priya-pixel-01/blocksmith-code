import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, __resetDbForTests } from "./client.js";
import { JobRepository, WorkspaceRepository } from "./repository.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "blocksmith-repository-"));
  __resetDbForTests();
  const db = getDb(join(dir, "blocksmith.sqlite"));
  return { dir, jobs: new JobRepository(db), workspaces: new WorkspaceRepository(db) };
}

test("addCost round-trips through microcents without drift and accumulates across calls", () => {
  const { dir, jobs, workspaces } = setup();
  try {
    workspaces.upsert({ id: "ws_1", rootPath: "/fake/repo", isGitRepo: true });
    const job = jobs.createJob({ batchId: "batch_1", workspaceId: "ws_1", sourceKind: "image", sourceRef: "source.png", implementationMode: "sling_model" });
    jobs.update(job.id, {
      openQuestionsJson: JSON.stringify([{ id: "endpoint", prompt: "What endpoint?", kind: "text", options: [], required: true }]),
      questionAnswersJson: JSON.stringify([{ questionId: "endpoint", value: "/subscribe" }]),
    });
    assert.equal(jobs.getJob(job.id)!.implementationMode, "sling_model");
    assert.equal(jobs.getJob(job.id)!.openQuestions[0]?.id, "endpoint");
    assert.equal(jobs.getJob(job.id)!.questionAnswers[0]?.value, "/subscribe");
    assert.equal(job.costUsd, null, "a freshly created job has no cost yet");

    jobs.addCost(job.id, 0.0012);
    assert.equal(jobs.getJob(job.id)!.costUsd, 0.0012);

    jobs.addCost(job.id, 0.0038);
    assert.equal(jobs.getJob(job.id)!.costUsd, 0.005, "0.0012 + 0.0038 should round-trip exactly through the microcents column");

    jobs.addCost(job.id, null);
    assert.equal(jobs.getJob(job.id)!.costUsd, 0.005, "a null delta (no usage data reported) must be a no-op");
  } finally {
    __resetDbForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listBatchesByWorkspace groups a workspace's jobs by batchId with per-status counts, newest batch first", () => {
  const { dir, jobs, workspaces } = setup();
  try {
    workspaces.upsert({ id: "ws_1", rootPath: "/fake/repo", isGitRepo: true });
    workspaces.upsert({ id: "ws_2", rootPath: "/other/repo", isGitRepo: true });

    const a1 = jobs.createJob({ batchId: "batch_a", workspaceId: "ws_1", sourceKind: "image", sourceRef: "a1.png" });
    const a2 = jobs.createJob({ batchId: "batch_a", workspaceId: "ws_1", sourceKind: "image", sourceRef: "a2.png" });
    jobs.setStatus(a1.id, "done");
    jobs.setStatus(a2.id, "failed");

    jobs.createJob({ batchId: "batch_b", workspaceId: "ws_1", sourceKind: "pdf", sourceRef: "b1.pdf" });
    jobs.createJob({ batchId: "batch_other_ws", workspaceId: "ws_2", sourceKind: "image", sourceRef: "c1.png" });

    const summaries = jobs.listBatchesByWorkspace("ws_1");

    assert.equal(summaries.length, 2, "only ws_1's two batches should be returned, not ws_2's");
    assert.deepEqual(
      summaries.map((s) => s.batchId).sort(),
      ["batch_a", "batch_b"],
    );

    const batchA = summaries.find((s) => s.batchId === "batch_a")!;
    assert.equal(batchA.jobCount, 2);
    assert.deepEqual(batchA.byStatus, { done: 1, failed: 1 });

    const batchB = summaries.find((s) => s.batchId === "batch_b")!;
    assert.equal(batchB.jobCount, 1);
    assert.deepEqual(batchB.byStatus, { created: 1 });
  } finally {
    __resetDbForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});
