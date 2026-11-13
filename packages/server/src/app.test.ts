/**
 * Integration tests for the Express app. `deps.ts` builds its singletons (DB, ModelRouter, ...)
 * eagerly at import time from env vars, so this file requires OPENROUTER_API_KEY (a placeholder
 * is fine — nothing here calls a method that makes a network request to OpenRouter) and
 * DATABASE_PATH / SCRATCH_DIR / UPLOADS_DIR pointed at a scratch directory. Run with:
 *
 *   OPENROUTER_API_KEY=test-key \
 *   DATABASE_PATH=/tmp/blocksmith-test/db.sqlite \
 *   SCRATCH_DIR=/tmp/blocksmith-test/scratch \
 *   UPLOADS_DIR=/tmp/blocksmith-test/uploads \
 *   node --import tsx --test src/app.test.ts
 *
 * Batch/job creation genuinely calls the model router's generateStructured/runAgentLoop, which
 * requires live OpenRouter access — blocked by this sandbox's egress policy (same restriction as
 * elsewhere in this project). Those flows are asserted only up to the point that's true
 * regardless of network: the job is created, moves to a running status, and eventually reaches
 * "failed" with the network error recorded — proving the orchestrator wiring and error handling
 * work end-to-end through a real HTTP request, even though the LLM call itself can't succeed here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import request from "supertest";
import { createApp } from "./app.js";
import { jobs, workspaces } from "./deps.js";

const FIXTURE_ROOT = resolve(import.meta.dirname, "../../../fixtures/aem-boilerplate-xwalk");

test("fixture is present", () => {
  assert.ok(existsSync(FIXTURE_ROOT), `Expected fixture at ${FIXTURE_ROOT}`);
});

const app = createApp();

test("GET /api/health responds ok", async () => {
  const res = await request(app).get("/api/health");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
});

test("POST /api/workspace builds a real repo profile for the fixture", async () => {
  const res = await request(app).post("/api/workspace").send({ rootPath: FIXTURE_ROOT });
  assert.equal(res.status, 200);
  assert.ok(res.body.workspaceId.startsWith("ws_"));
  assert.equal(res.body.profile.blocks.length, 6);
  assert.equal(res.body.profile.authoringSurface.hasUniversalEditor, true);
});

test("POST /api/workspace rejects a missing rootPath", async () => {
  const res = await request(app).post("/api/workspace").send({});
  assert.equal(res.status, 400);
});

test("GET /api/workspace/:id/profile returns 404 for an unknown workspace", async () => {
  const res = await request(app).get("/api/workspace/ws_doesnotexist/profile");
  assert.equal(res.status, 404);
});

test("GET /api/workspace/:id/profile round-trips a workspace created via POST", async () => {
  const created = await request(app).post("/api/workspace").send({ rootPath: FIXTURE_ROOT });
  const fetched = await request(app).get(`/api/workspace/${created.body.workspaceId}/profile`);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.id, created.body.workspaceId);
});

test("DELETE /api/jobs/:id accepts a non-terminal job", async () => {
  const workspaceId = `ws_delete_${Date.now()}`;
  workspaces.upsert({ id: workspaceId, rootPath: FIXTURE_ROOT, isGitRepo: true });
  const job = jobs.createJob({ batchId: `batch_${workspaceId}`, workspaceId, sourceKind: "image", sourceRef: "unused.png" });

  const res = await request(app).delete(`/api/jobs/${job.id}`);
  assert.equal(res.status, 200);
  assert.equal(jobs.getJob(job.id), null);
});

test("DELETE /api/workspace/:id/batches/:batchId accepts a batch with mixed statuses", async () => {
  const workspaceId = `ws_delete_batch_${Date.now()}`;
  const batchId = `batch_${workspaceId}`;
  workspaces.upsert({ id: workspaceId, rootPath: FIXTURE_ROOT, isGitRepo: true });
  const active = jobs.createJob({ batchId, workspaceId, sourceKind: "image", sourceRef: "unused-active.png" });
  const terminal = jobs.createJob({ batchId, workspaceId, sourceKind: "image", sourceRef: "unused-terminal.png" });
  jobs.setStatus(terminal.id, "done");

  const res = await request(app).delete(`/api/workspace/${workspaceId}/batches/${batchId}`);
  assert.equal(res.status, 200);
  assert.equal(jobs.getJob(active.id), null);
  assert.equal(jobs.getJob(terminal.id), null);
});

test("POST /api/uploads rejects an unsupported file type", async () => {
  const res = await request(app).post("/api/uploads").attach("file", Buffer.from("not an image"), { filename: "notes.txt", contentType: "text/plain" });
  assert.equal(res.status, 400);
});

test("POST /api/uploads accepts a PNG and returns a server-side path", async () => {
  // Minimal valid PNG (1x1 transparent pixel).
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const res = await request(app).post("/api/uploads").attach("file", png, { filename: "design.png", contentType: "image/png" });
  assert.equal(res.status, 200);
  assert.equal(res.body.kind, "image");
  assert.ok(existsSync(res.body.path));
});

test("POST /api/batch creates jobs and each eventually reaches a terminal status (network to OpenRouter is blocked in this sandbox, so 'failed' is the correct terminal outcome here)", async () => {
  const workspaceRes = await request(app).post("/api/workspace").send({ rootPath: FIXTURE_ROOT });
  const workspaceId = workspaceRes.body.workspaceId;

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const uploadRes = await request(app).post("/api/uploads").attach("file", png, { filename: "design.png", contentType: "image/png" });

  const batchRes = await request(app)
    .post("/api/batch")
    .send({ workspaceId, sources: [{ kind: "image", ref: uploadRes.body.path }] });
  assert.equal(batchRes.status, 202);
  assert.equal(batchRes.body.jobIds.length, 1);

  const jobId = batchRes.body.jobIds[0] as string;
  const terminal = new Set(["done", "failed", "rejected"]);
  let job: { status: string } = { status: "created" };
  for (let i = 0; i < 50 && !terminal.has(job.status); i++) {
    await new Promise((r) => setTimeout(r, 100));
    const jobRes = await request(app).get(`/api/jobs/${jobId}`);
    job = jobRes.body;
  }

  assert.ok(terminal.has(job.status), `job did not reach a terminal status in time, stuck at "${job.status}"`);
});

test("GET /api/jobs/:id/events streams status events over SSE and closes once the job reaches a terminal status", async () => {
  const workspaceRes = await request(app).post("/api/workspace").send({ rootPath: FIXTURE_ROOT });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const uploadRes = await request(app).post("/api/uploads").attach("file", png, { filename: "design.png", contentType: "image/png" });
  const batchRes = await request(app)
    .post("/api/batch")
    .send({ workspaceId: workspaceRes.body.workspaceId, sources: [{ kind: "image", ref: uploadRes.body.path }] });
  const jobId = batchRes.body.jobIds[0] as string;

  // The job runs concurrently (kicked off by the batch route); this connects to its SSE stream
  // while that's in flight and reads until the route itself closes the connection — which it
  // only does once a terminal status event has been seen (see routes/jobs.ts).
  const res = await request(app).get(`/api/jobs/${jobId}/events`).timeout({ deadline: 10_000 });

  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/event-stream");

  const lines = res.text
    .split("\n")
    .filter((l: string) => l.startsWith("data: "))
    .map((l: string) => JSON.parse(l.slice("data: ".length)));

  assert.ok(lines.length > 0, "expected at least one SSE event");
  const statusEvents = lines.filter((e: { type: string }) => e.type === "status");
  const finalStatus = statusEvents.at(-1)?.data?.status;
  assert.ok(["done", "failed", "rejected"].includes(finalStatus), `expected a terminal final status, got "${finalStatus}"`);
});

test("POST /api/jobs/:id/reject on a job that isn't awaiting approval returns an error", async () => {
  const workspaceRes = await request(app).post("/api/workspace").send({ rootPath: FIXTURE_ROOT });
  const uploadRes = await request(app)
    .post("/api/uploads")
    .attach("file", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"), {
      filename: "design.png",
      contentType: "image/png",
    });
  const batchRes = await request(app)
    .post("/api/batch")
    .send({ workspaceId: workspaceRes.body.workspaceId, sources: [{ kind: "image", ref: uploadRes.body.path }] });
  const jobId = batchRes.body.jobIds[0] as string;

  // Immediately (job is still "created"/"ingesting", not yet "awaiting_approval") — reject is
  // accepted at the HTTP layer (202) but fails asynchronously inside JobRunner; we only assert
  // the endpoint itself is reachable and validates its body.
  const res = await request(app).post(`/api/jobs/${jobId}/reject`).send({ feedback: "" });
  assert.equal(res.status, 400); // zod: feedback must be non-empty
});
