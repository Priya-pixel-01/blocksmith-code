import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tool } from "ai";
import { z } from "zod";
import type { RepoProfile } from "../schemas/repo-profile.js";

const execFileAsync = promisify(execFile);
const LINT_TIMEOUT_MS = 60_000;

export interface LintResult {
  passed: boolean;
  output: string;
}

/** Runs the project's own lint command (e.g. `npm run lint`) inside `workspaceDir`. No fallback linter is bundled — a repo without a lint script just reports that plainly, rather than second-guessing the project's own conventions with a different set of rules. */
export async function runLint(workspaceDir: string, lintCommand: string | null): Promise<LintResult> {
  if (!lintCommand) {
    return { passed: true, output: "No lint command detected for this repo — skipped." };
  }
  try {
    const { stdout, stderr } = await execFileAsync("npm", ["run", lintCommand], {
      cwd: workspaceDir,
      timeout: LINT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { passed: true, output: [stdout, stderr].filter(Boolean).join("\n") };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { passed: false, output: [e.stdout, e.stderr].filter(Boolean).join("\n") || e.message };
  }
}

export function createRunLintTool(workspaceDir: string, repoProfile: RepoProfile) {
  const run_lint = tool({
    description: "Run this project's own lint command against the files written so far in the workspace. Use this after writing a block's files, before finishing.",
    inputSchema: z.object({}),
    execute: async () => runLint(workspaceDir, repoProfile.conventions.lintCommand),
  });
  return { run_lint };
}
