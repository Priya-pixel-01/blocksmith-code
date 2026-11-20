import { Router } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { ensureWorkspaceProfile } from "@blocksmith/core";
import { workspaces, jobs, jobRunner, router as modelRouter } from "../deps.js";
import { workspaceIdFor } from "../workspace-id.js";

export const workspaceRouter = Router();
const execFileAsync = promisify(execFile);

const SetWorkspaceSchema = z.object({
  rootPath: z.string().min(1),
});

async function pickFolderPath(): Promise<string | null> {
  if (process.platform !== "win32") {
    return null;
  }

  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Windows.Forms; public sealed class BlocksmithWindow : IWin32Window { [DllImport(\"user32.dll\")] private static extern IntPtr GetForegroundWindow(); public IntPtr Handle { get; private set; } public BlocksmithWindow() { Handle = GetForegroundWindow(); } }'",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Select repository folder'",
    "$dialog.ShowNewFolderButton = $false",
    "$owner = New-Object BlocksmithWindow",
    "if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }",
  ].join("; ");

  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-STA",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], { timeout: 5 * 60 * 1000 });

  const selected = stdout.trim();
  return selected.length > 0 ? selected : null;
}

workspaceRouter.post("/workspace", async (req, res, next) => {
  try {
    const { rootPath } = SetWorkspaceSchema.parse(req.body);
    const workspaceId = workspaceIdFor(rootPath);

    const profile = await ensureWorkspaceProfile({
      workspaceId,
      rootPath,
      workspaces,
      router: modelRouter,
    });

    res.json({ workspaceId, profile });
  } catch (err) {
    next(err);
  }
});

workspaceRouter.post("/workspace/browse", async (_req, res, next) => {
  try {
    const rootPath = await pickFolderPath();
    res.json({ rootPath });
  } catch (err) {
    next(err);
  }
});

workspaceRouter.get("/workspace/:id/profile", (req, res) => {
  const workspace = workspaces.get(req.params.id);
  if (!workspace) {
    res.status(404).json({ error: `Workspace ${req.params.id} not found` });
    return;
  }
  res.json(workspace);
});

/** Lets the UI list a workspace's past batches — there's no separate `batches` table, so this groups jobs by their shared batchId. */
workspaceRouter.get("/workspace/:id/batches", (req, res) => {
  const workspace = workspaces.get(req.params.id);
  if (!workspace) {
    res.status(404).json({ error: `Workspace ${req.params.id} not found` });
    return;
  }
  res.json({ batches: jobs.listBatchesByWorkspace(req.params.id) });
});

workspaceRouter.delete("/workspace/:id/batches/:batchId", async (req, res, next) => {
  const workspace = workspaces.get(req.params.id);
  if (!workspace) {
    res.status(404).json({ error: `Workspace ${req.params.id} not found` });
    return;
  }
  const batchJobs = jobs.listByBatch(req.params.batchId);
  if (batchJobs.length === 0 || batchJobs.some((job) => job.workspaceId !== req.params.id)) {
    res.status(404).json({ error: `Batch ${req.params.batchId} not found` });
    return;
  }
  try {
    await Promise.all(batchJobs.map((job) => jobRunner.cancelAndWait(job.id)));
    jobs.deleteBatch(req.params.batchId);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

workspaceRouter.post("/workspace/:id/refresh", async (req, res, next) => {
  try {
    const { force } = z.object({ force: z.boolean().optional() }).parse(req.body);
    const workspace = workspaces.get(req.params.id);
    if (!workspace) {
      res.status(404).json({ error: `Workspace ${req.params.id} not found` });
      return;
    }
    const profile = await ensureWorkspaceProfile({
      workspaceId: workspace.id,
      rootPath: workspace.rootPath,
      workspaces,
      router: modelRouter,
      force: force ?? true, // Default to true for backwards compatibility
    });
    res.json({ workspaceId: workspace.id, profile });
  } catch (err) {
    next(err);
  }
});
