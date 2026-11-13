import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, cp, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";

const execFileAsync = promisify(execFile);

export interface JobWorkspace {
  /** Absolute path to the isolated copy the Builder writes into. Never the target repo root itself. */
  dir: string;
  isGitWorktree: boolean;
  /** Set only when isGitWorktree — the branch the worktree was created on. */
  branchName: string | null;
}

/**
 * Creates an isolated copy of the target repo for one job to build and verify in, so parallel
 * jobs never race on the same files and nothing touches the real repo until the Writer runs.
 * Lives under `scratchDir/workspaces/<jobId>`, never nested inside the target repo itself —
 * `git worktree add` doesn't require that, and nesting it would risk the checked-out files
 * looking like untracked changes in the user's own working tree.
 */
export async function createJobWorkspace(options: {
  targetRoot: string;
  scratchDir: string;
  jobId: string;
  blockName: string;
  isGitRepo: boolean;
}): Promise<JobWorkspace> {
  const { targetRoot, scratchDir, jobId, blockName, isGitRepo } = options;
  const workspacesDir = join(scratchDir, "workspaces");
  const dir = join(workspacesDir, jobId);
  await mkdir(workspacesDir, { recursive: true });

  // Idempotent: a re-run after a crash shouldn't fail because the directory already exists.
  if (existsSync(dir)) {
    await removeJobWorkspaceDir(targetRoot, dir, isGitRepo);
  }

  if (isGitRepo) {
    const baseBranchName = `blocksmith/${blockName}-${jobId.replace(/^job_/, "").slice(0, 8)}`;
    const branchName = await chooseAvailableBranchName(targetRoot, baseBranchName);
    // AEM projects (e.g. WKND) have jcr_root config paths well past Windows' default 260-char
    // MAX_PATH, which otherwise makes `git worktree add` fail outright. Setting this on the repo
    // (rather than just passing -c to this command) also covers the `git add`/`commit` the
    // Writer later runs against this same worktree.
    await execFileAsync("git", ["config", "core.longpaths", "true"], { cwd: targetRoot }).catch(() => {});
    await execFileAsync("git", ["worktree", "remove", "--force", dir], { cwd: targetRoot }).catch(() => {});
    await execFileAsync("git", ["worktree", "add", "-b", branchName, dir, "HEAD"], { cwd: targetRoot });
    // `git worktree add` checks out tracked files only — node_modules is (almost always) gitignored,
    // so tools like the project's own `npm run lint` would otherwise resolve nothing, or worse,
    // fall back to whatever eslint/stylelint happens to be on PATH instead of the pinned version.
    await symlinkNodeModules(targetRoot, dir);
    return { dir, isGitWorktree: true, branchName };
  }

  await cp(targetRoot, dir, {
    recursive: true,
    filter: (src) => !isExcludedFromCopy(src),
  });
  await symlinkNodeModules(targetRoot, dir);
  return { dir, isGitWorktree: false, branchName: null };
}

async function symlinkNodeModules(targetRoot: string, dir: string): Promise<void> {
  const rootNodeModules = join(targetRoot, "node_modules");
  if (!existsSync(rootNodeModules)) return;
  await symlink(rootNodeModules, join(dir, "node_modules"), "dir").catch(() => {
    // Non-fatal — lint just won't resolve project deps in the isolated copy if this fails.
  });
}

function isExcludedFromCopy(path: string): boolean {
  return [`${sep}node_modules`, `${sep}.git`, `${sep}.blocksmith`].some((segment) => path.includes(segment));
}

/** Removes the isolated copy. The branch itself (if any) is left in place — callers that want it gone too should delete it separately. */
export async function removeJobWorkspace(targetRoot: string, workspace: JobWorkspace): Promise<void> {
  await removeJobWorkspaceDir(targetRoot, workspace.dir, workspace.isGitWorktree);
}

async function removeJobWorkspaceDir(targetRoot: string, dir: string, isGitWorktree: boolean): Promise<void> {
  if (isGitWorktree) {
    await execFileAsync("git", ["worktree", "remove", "--force", dir], { cwd: targetRoot }).catch(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    return;
  }
  await rm(dir, { recursive: true, force: true });
}

async function chooseAvailableBranchName(targetRoot: string, baseName: string): Promise<string> {
  if (!(await branchExists(targetRoot, baseName))) return baseName;
  for (let i = 1; i <= 999; i++) {
    const candidate = `${baseName}-${i}`;
    if (!(await branchExists(targetRoot, candidate))) return candidate;
  }
  throw new Error(`Could not find an available branch name for ${baseName}`);
}

async function branchExists(targetRoot: string, branchName: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], { cwd: targetRoot });
    return true;
  } catch {
    return false;
  }
}
