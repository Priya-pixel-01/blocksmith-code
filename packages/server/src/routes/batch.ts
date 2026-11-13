import { Router } from "express";
import { z } from "zod";
import pLimit from "p-limit";
import { readFile } from "node:fs/promises";
import { jobs, jobRunner, figmaCache, workspaces } from "../deps.js";
import { parseFigmaUrl, buildNormalizedUrl, requiresAemImplementationMode } from "@blocksmith/core";

export const batchRouter = Router();

const BatchSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("figma"), ref: z.string().url() }),
  z.object({ kind: z.literal("image"), ref: z.string().min(1) }), // server-side path from POST /uploads
  z.object({ kind: z.literal("pdf"), ref: z.string().min(1) }), // server-side path from POST /uploads
]);

const CreateBatchSchema = z.object({
  workspaceId: z.string().min(1),
  sources: z.array(BatchSourceSchema).min(1).max(20),
  forceRefresh: z.boolean().optional(),
  implementationMode: z.enum(["properties", "sling_model"]).optional(),
});

const CONCURRENCY = 3;

/** Creates one job per source and starts them running concurrently (capped) toward awaiting_approval. */
batchRouter.post("/batch", (req, res, next) => {
  try {
    const { workspaceId, sources, forceRefresh, implementationMode } = CreateBatchSchema.parse(req.body);
    const workspace = workspaces.get(workspaceId);
    if (!workspace) {
      res.status(404).json({ error: `Workspace ${workspaceId} not found` });
      return;
    }
    if (requiresAemImplementationMode(workspace.repoProfile?.projectType ?? "unknown") && !implementationMode) {
      res.status(400).json({ error: "Choose properties-based or Sling Model implementation mode before submitting an AEM job." });
      return;
    }
    const batchId = `batch_${Date.now().toString(36)}`;

    const created = sources.map((source) => jobs.createJob({ batchId, workspaceId, sourceKind: source.kind, sourceRef: source.ref, implementationMode: implementationMode ?? null }));

    // Update jobRunner with forceRefresh setting for this batch
    if (forceRefresh) {
      jobRunner.setForceRefresh(true);
    }

    const limit = pLimit(CONCURRENCY);
    void Promise.allSettled(created.map((job) => limit(() => jobRunner.runToApproval(job.id)))).finally(() => {
      // Reset forceRefresh after batch completes
      jobRunner.setForceRefresh(false);
    });

    res.status(202).json({ batchId, jobIds: created.map((j) => j.id) });
  } catch (err) {
    next(err);
  }
});

/** Preview endpoint to check if a Figma URL has cached data and return preview info */
batchRouter.post("/figma/preview", async (req, res, next) => {
  try {
    const { url } = z.object({ url: z.string().url() }).parse(req.body);
    const { fileKey, nodeId } = parseFigmaUrl(url);
    const normalizedUrl = buildNormalizedUrl(fileKey, nodeId);
    
    const cached = figmaCache.get(normalizedUrl);
    if (cached && cached.previewImagePath) {
      try {
        // Read the image file and convert to base64.
        const imageBuffer = await readFile(cached.previewImagePath);
        const base64Image = imageBuffer.toString("base64");

        res.json({
          cached: true,
          previewImage: `data:image/png;base64,${base64Image}`,
          updatedAt: cached.updatedAt,
        });
        return;
      } catch (err) {
        // Cached paths can become stale across machines/workspaces.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          figmaCache.delete(normalizedUrl);
          res.json({ cached: false });
          return;
        }
        throw err;
      }
    }

    res.json({ cached: false });
  } catch (err) {
    next(err);
  }
});
