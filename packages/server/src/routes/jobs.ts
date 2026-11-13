import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Router } from "express";
import { z } from "zod";
import { agentTracePath, batchTitleFromIntent, resolveInSandbox, SandboxViolationError, type JobEvent } from "@blocksmith/core";
import { jobs, jobRunner, eventBus } from "../deps.js";
import { env } from "../env.js";

export const jobsRouter = Router();

const TERMINAL_STATUSES = new Set(["done", "failed", "rejected", "code_only"]);

/** Verdict screenshots live on disk at scratchDir/<jobId>/verify-<n>/<file>.png â€” turn each into a URL the client can fetch, without exposing the server's scratchDir layout. */
function withScreenshotUrls(job: ReturnType<typeof jobs.getJob>) {
  if (!job) return job;
  const withTitle = { ...job, batchTitle: batchTitleFromIntent(job.blockSpec) };
  if (!job.verdict) return withTitle;
  const verdict = job.verdict as { screenshotPaths?: string[] };
  if (!verdict.screenshotPaths) return job;

  const jobScratchRoot = resolve(env.scratchDir, job.id);
  const screenshotUrls = verdict.screenshotPaths
    .map((p) => resolve(p))
    .filter((p) => p.startsWith(jobScratchRoot))
    .map((p) => `/api/jobs/${job.id}/screenshots/${p.slice(jobScratchRoot.length + 1).replace(/\\/g, "/")}`);

  return { ...withTitle, verdict: { ...verdict, screenshotUrls } };
}

jobsRouter.get("/jobs", (req, res) => {
  const batchId = typeof req.query.batchId === "string" ? req.query.batchId : null;
  if (!batchId) {
    res.status(400).json({ error: "Query param 'batchId' is required" });
    return;
  }
  res.json({ jobs: jobs.listByBatch(batchId).map(withScreenshotUrls) });
});

jobsRouter.get("/jobs/:id", (req, res) => {
  const job = jobs.getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: `Job ${req.params.id} not found` });
    return;
  }
  res.json(withScreenshotUrls(job));
});

jobsRouter.get("/jobs/:id/agent-trace", (req, res) => {
  const job = jobs.getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: `Job ${req.params.id} not found` });
    return;
  }
  try {
    const tracePath = agentTracePath(env.scratchDir, job.id);
    if (!existsSync(tracePath)) {
      res.status(404).json({ error: "Agent trace is not available yet" });
      return;
    }
    res.type("application/x-ndjson");
    res.setHeader("Content-Disposition", `attachment; filename="${job.id}-agent-trace.jsonl"`);
    res.sendFile(tracePath);
  } catch {
    res.status(500).json({ error: "Could not load agent trace" });
  }
});

jobsRouter.get("/jobs/:id/screenshots/:iteration/:filename", (req, res) => {
  const { id, iteration, filename } = req.params;
  try {
    const jobScratchDir = resolve(env.scratchDir, id);
    const absPath = resolveInSandbox(jobScratchDir, `${iteration}/${filename}`);
    if (!existsSync(absPath)) {
      res.status(404).json({ error: "Screenshot not found" });
      return;
    }
    res.sendFile(absPath);
  } catch (err) {
    if (err instanceof SandboxViolationError) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    res.status(500).json({ error: "Internal error" });
  }
});

jobsRouter.get("/jobs/:id/events", (req, res) => {
  const jobId = req.params.id;
  const job = jobs.getJob(jobId);
  if (!job) {
    res.status(404).json({ error: `Job ${jobId} not found` });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (event: JobEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  for (const event of jobs.listEvents(jobId)) send(event);

  const latest = jobs.getJob(jobId);
  if (latest && TERMINAL_STATUSES.has(latest.status)) {
    res.end();
    return;
  }

  const onEvent = (event: JobEvent) => {
    send(event);
    if (event.type === "status" && event.data && TERMINAL_STATUSES.has((event.data as { status: string }).status)) {
      cleanup();
      res.end();
    }
  };
  const cleanup = () => eventBus.off(jobId, onEvent);

  eventBus.on(jobId, onEvent);
  req.on("close", cleanup);
});

const RejectSchema = z.object({ feedback: z.string().min(1) });
const AnswerSchema = z.object({
  answers: z.array(z.object({ questionId: z.string().min(1), value: z.string().min(1) })).min(1),
  feedback: z.string().max(4000).optional(),
});

jobsRouter.post("/jobs/:id/answers", async (req, res, next) => {
  try {
    const { answers, feedback } = AnswerSchema.parse(req.body);
    await jobRunner.answerQuestions(req.params.id, answers, feedback);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
jobsRouter.post("/jobs/:id/approve", (req, res) => {
  const jobId = req.params.id;
  const job = jobs.getJob(jobId);
  if (!job) {
    res.status(404).json({ error: `Job ${jobId} not found` });
    return;
  }
  if (job.status !== "awaiting_approval" && job.status !== "awaiting_answers") {
    res.status(409).json({ error: `Job ${jobId} is not awaiting approval (status: ${job.status})` });
    return;
  }

  // The full build â‡„ verify â‡„ write pipeline can run for minutes (up to 3 real render/lint/axe/
  // vision-critique cycles) â€” same fire-and-respond pattern as batch creation. The client follows
  // progress via the job's SSE event stream, not this response.
  void jobRunner.approve(jobId).catch((err) => {
    // Failures surface as a job event/status (see JobRunner.approve's catch block), not as an
    // HTTP error â€” the request has already been accepted at this point.
    // eslint-disable-next-line no-console
    console.error(`approve build/verify/write failed for job ${jobId}:`, err);
  });
  res.status(202).json({ ok: true });
});

jobsRouter.post("/jobs/:id/approve-code-only", (req, res) => {
  const jobId = req.params.id;
  const job = jobs.getJob(jobId);
  if (!job) {
    res.status(404).json({ error: `Job ${jobId} not found` });
    return;
  }
  if (job.status !== "awaiting_approval") {
    res.status(409).json({ error: `Job ${jobId} is not awaiting approval (status: ${job.status})` });
    return;
  }

  void jobRunner.approveCodeOnly(jobId).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`approve code-only failed for job ${jobId}:`, err);
  });
  res.status(202).json({ ok: true });
});

jobsRouter.post("/jobs/:id/reject", (req, res, next) => {
  try {
    const { feedback } = RejectSchema.parse(req.body);
    void jobRunner.reject(req.params.id, feedback).catch((err) => {
      // Errors during the async re-run surface as a job event/status (see JobRunner.reject),
      // not as an HTTP error â€” the request has already been accepted at this point.
      // eslint-disable-next-line no-console
      console.error(`reject re-run failed for job ${req.params.id}:`, err);
    });
    res.status(202).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

jobsRouter.post("/jobs/:id/terminate", async (req, res, next) => {
  const job = jobs.getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: `Job ${req.params.id} not found` });
    return;
  }
  try {
    await jobRunner.cancelAndWait(job.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

jobsRouter.post("/jobs/:id/post-feedback", (req, res, next) => {
  try {
    const { feedback } = RejectSchema.parse(req.body);
    const jobId = req.params.id;
    const job = jobs.getJob(jobId);
    if (!job) {
      res.status(404).json({ error: `Job ${jobId} not found` });
      return;
    }
    if (job.status !== "deployed" && job.status !== "done") {
      res.status(409).json({ error: `Job ${jobId} is not deployed (status: ${job.status}) â€” post-feedback only works on deployed jobs` });
      return;
    }

    // Post-deployment feedback triggers an iterative build/verify/write cycle, same as the
    // approval pipeline. The client follows progress via the job's SSE event stream.
    void jobRunner.refineAfterDeployment(jobId, feedback).catch((err) => {
      // Failures surface as a job event/status, not as an HTTP error.
      // eslint-disable-next-line no-console
      console.error(`post-feedback refinement failed for job ${jobId}:`, err);
    });
    res.status(202).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

jobsRouter.post("/jobs/:id/retry", (req, res) => {
  const jobId = req.params.id;
  const job = jobs.getJob(jobId);
  if (!job) {
    res.status(404).json({ error: `Job ${jobId} not found` });
    return;
  }
  if (job.status !== "failed" && job.status !== "rejected") {
    res.status(409).json({ error: `Job ${jobId} cannot be retried from status ${job.status}` });
    return;
  }

  const retried = jobs.createJob({
    batchId: job.batchId,
    workspaceId: job.workspaceId,
    sourceKind: job.sourceKind,
    sourceRef: job.sourceRef,
    implementationMode: job.implementationMode,
  });

  void jobRunner.runToApproval(retried.id).catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`retry failed for original job ${jobId} (new job ${retried.id}):`, err);
  });

  res.status(202).json({ ok: true, jobId: retried.id, batchId: retried.batchId });
});

jobsRouter.delete("/jobs/:id", async (req, res, next) => {
  const jobId = req.params.id;
  const job = jobs.getJob(jobId);
  if (!job) {
    res.status(404).json({ error: `Job ${jobId} not found` });
    return;
  }
  try {
    await jobRunner.cancelAndWait(jobId);
    jobs.deleteJob(jobId);
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});
