import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveInSandbox } from "../tools/sandbox.js";
import type { JobWorkspace } from "./isolate.js";

const execFileAsync = promisify(execFile);

const UE_ROOT_JSON_FILES = new Set(["component-definition.json", "component-models.json", "component-filters.json"]);
const AEM_MODULE_PREFIXES = ["ui.apps/", "ui.content/", "ui.frontend/", "core/", "dispatcher/", "all/", "it.tests/"];

/**
 * Second, independent check that a path is something Blocksmith should ever write to the user's
 * real repo — blocks/, styles/, or the three UE root JSON files. The Planner never computes
 * anything outside this shape and the Builder is already restricted to the plan's exact file
 * list, but this is the last line of defense before touching the user's actual repository, so it
 * re-checks rather than trusting that chain of custody alone.
 */
export function isAllowedWriterPath(relativePath: string): boolean {
  if (relativePath.startsWith("blocks/") || relativePath.startsWith("styles/")) return true;
  if (AEM_MODULE_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) return true;
  return UE_ROOT_JSON_FILES.has(relativePath);
}

export interface WriteResultOptions {
  targetRoot: string;
  workspace: JobWorkspace;
  jobId: string;
  blockName: string;
  filesToCreate: string[];
  filesToModify: string[];
  writeDirectly?: boolean;
}

export interface WriteResult {
  mode: "git-commit" | "direct-write";
  branchName: string | null;
  commitSha: string | null;
  filesWritten: string[];
  backupDir: string | null;
}

/**
 * Applies the Builder's output to the target repo. Git repo: the isolated workspace is already a
 * worktree on a real branch (see isolate.ts) — the branch already contains the files, so this
 * just stages and commits exactly the plan's allowlisted files on it, nothing more. Non-git:
 * copies the same allowlisted files directly into the target folder, backing up anything they'd
 * overwrite to .blocksmith/backup/<jobId>/ first.
 */
export async function writeResult(options: WriteResultOptions): Promise<WriteResult> {
  const allowedPaths = [...new Set([...options.filesToCreate, ...options.filesToModify])].filter(isAllowedWriterPath);
  if (allowedPaths.length === 0) {
    throw new Error("Writer: no files to write — the plan's file list was empty or none passed the path allowlist");
  }

  const existingInWorkspace = allowedPaths.filter((p) => existsSync(resolveInSandbox(options.workspace.dir, p)));
  if (existingInWorkspace.length === 0) {
    throw new Error(`Writer: none of the planned files exist in the built workspace (${allowedPaths.join(", ")}) — did the Builder actually run?`);
  }

  if (options.workspace.isGitWorktree && !options.writeDirectly) {
    return commitInWorktree(options, existingInWorkspace);
  }
  return directWrite(options, existingInWorkspace);
}

async function commitInWorktree(options: WriteResultOptions, files: string[]): Promise<WriteResult> {
  const { workspace, blockName } = options;
  await execFileAsync("git", ["add", "--", ...files], { cwd: workspace.dir });

  const { stdout: staged } = await execFileAsync("git", ["diff", "--cached", "--name-only"], { cwd: workspace.dir });
  if (!staged.trim()) {
    throw new Error("Writer: git add produced no staged changes — the built files may be identical to what's already committed");
  }

  await execFileAsync("git", ["commit", "-m", `Add/update ${blockName} block via Blocksmith`], { cwd: workspace.dir });
  const { stdout: sha } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace.dir });

  return { mode: "git-commit", branchName: workspace.branchName, commitSha: sha.trim(), filesWritten: files, backupDir: null };
}

async function directWrite(options: WriteResultOptions, files: string[]): Promise<WriteResult> {
  const { targetRoot, workspace, jobId } = options;
  const backupDir = join(targetRoot, ".blocksmith", "backup", jobId);
  let backedUpAnything = false;
  const written: string[] = [];

  for (const relPath of files) {
    const srcPath = resolveInSandbox(workspace.dir, relPath);
    const destPath = resolveInSandbox(targetRoot, relPath);

    if (existsSync(destPath)) {
      const backupPath = resolveInSandbox(backupDir, relPath);
      await mkdir(dirname(backupPath), { recursive: true });
      await copyFile(destPath, backupPath);
      backedUpAnything = true;
    }

    await mkdir(dirname(destPath), { recursive: true });
    await copyFile(srcPath, destPath);
    written.push(relPath);
  }

  return { mode: "direct-write", branchName: null, commitSha: null, filesWritten: written, backupDir: backedUpAnything ? backupDir : null };
}
