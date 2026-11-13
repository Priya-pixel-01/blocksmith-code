import { existsSync } from "node:fs";
import { tool } from "ai";
import type { RepoProfile } from "../schemas/repo-profile.js";
import type { BlockSpec } from "../schemas/block-spec.js";
import type { Plan } from "../schemas/plan.js";
import type { ModelRouter } from "../llm/router.js";
import { createFsTools } from "../tools/fs.js";
import { createBlockTools } from "../tools/blocks.js";
import { createRunLintTool, runLint, type LintResult } from "../tools/lint.js";
import { resolveInSandbox } from "../tools/sandbox.js";

const SYSTEM_PROMPT = `You are the Block Builder for Blocksmith. You write a real, production Adobe Edge \
Delivery Services block into an isolated copy of the target repo, following the plan a human has \
already approved.

Ground rules:
- You may ONLY write to the exact files listed in the plan (create or modify) — nothing else.
  Attempting to write elsewhere will be rejected by your tools.
- Match the repo's own conventions exactly: quote style, semicolons, import style — read a
  sibling block first (read_block) rather than guessing. Use the repo's own aem.js/scripts.js
  helpers (createOptimizedPicture, readBlockConfig, decorateIcons, etc.) instead of
  reimplementing them.
- If your decorate() function moves or restructures any element that came from the authored
  content (not one you created from scratch), call moveInstrumentation(from, to) on it — this is
  what keeps the block editable in the Universal Editor after the DOM changes shape. Skipping
  this silently breaks authoring; get it from the same helpers module sibling blocks import it
  from.
- CSS: use the token names given to you (reused existing tokens, and the names decided for any
  new tokens) — do not invent different custom property names. Write responsive rules only at
  the breakpoints given to you.
- Universal Editor wiring: if the repo uses the "fragments" model shape, read an existing UE-wired
  sibling block's _<name>.json (e.g. one from the plan's filesToCreate list, or read_block a
  similar existing block) to copy its exact structure, then write your own
  blocks/<name>/_<name>.json with "definitions", "models", and "filters" arrays shaped the same
  way, using the UE fields you were given. If the repo uses the "monolithic" shape instead, you
  must instead patch the existing root component-definition.json / component-models.json /
  component-filters.json — read them first with fs_read, add your entries under an existing
  appropriate group, and do not remove or reorder anything already there.
- OFFICIAL FIELD COLLAPSE in decorate() (Adobe aem.live + eslint-plugin-xwalk):
  Field collapse rules from the content model flow into the rendered HTML/AUE attributes.
  DO NOT hardcode field mapping. Instead:
  
  1. Read the actual block data structure (rows) — fields are already collapsed by AEM rendering.
  2. A base field like "button" with suffixes "buttonText", "buttonTitle", "buttonType" renders
     as a SINGLE semantic <a> tag with all attributes already applied.
  3. Extract content using the BASE field name only. Suffixed fields are already merged into it.
  4. Example: const buttonRow = rows[buttonIndex]; → already contains link+text+title+type merged
  5. Apply moveInstrumentation() to the collapsed element only once.
  
  Reserved suffixes (case-sensitive): Alt, Text, Title, Type, MimeType
  • Alt: alt attribute for images
  • Text: #text node content for links, heading content
  • Title: title attribute for links/elements
  • Type: type of heading (h1-h6) or link style (primary, secondary)
  • MimeType: MIME type inference for reference fields
  
  VALIDATION RULES (enforced by linter):
  • xwalk/max-cells: Keep ≤4 cells (collapse fields to reduce cell count)
  • xwalk/no-orphan-collapsible-fields: NEVER use suffix without base field
  • xwalk/invalid-field-name: Start with letter, only letters/numbers/_/-/:
  • xwalk/no-duplicate-fields: No duplicate field names
  • xwalk/no-custom-resource-types: Use generic blocks only
- Run run_lint after writing files and fix anything it reports before finishing. Do not leave
  known lint failures unaddressed.
- If you're re-building after a rejected verification pass, the feedback given to you describes
  exactly what was wrong — fix those specific issues, don't rewrite unrelated parts.`;

export interface BuildBlockOptions {
  /** The job's isolated workspace directory (never the target repo root itself). */
  workspaceDir: string;
  repoProfile: RepoProfile;
  blockSpec: BlockSpec;
  plan: Plan;
  router: ModelRouter;
  /** Issues from a previous Verifier pass, if this is a rebuild iteration. */
  feedback?: string;
}

export interface BuildResult {
  filesWritten: string[];
  filesMissing: string[];
  lint: LintResult;
  summary: string;
  costUsd: number | null;
}

export async function buildBlock({ workspaceDir, repoProfile, blockSpec, plan, router, feedback }: BuildBlockOptions): Promise<BuildResult> {
  const allowedPaths = [...plan.filesToCreate, ...plan.filesToModify];
  const tools = createBuilderTools(workspaceDir, repoProfile, allowedPaths);

  const prompt = buildPrompt(repoProfile, blockSpec, plan, allowedPaths, feedback);

  const loop = await router.runAgentLoop({
    role: "builder",
    system: SYSTEM_PROMPT,
    prompt,
    tools,
    maxSteps: 24,
  });

  const filesWritten = allowedPaths.filter((p) => existsSync(resolveInSandbox(workspaceDir, p)));
  const filesMissing = allowedPaths.filter((p) => !filesWritten.includes(p));
  const lint = await runLint(workspaceDir, repoProfile.conventions.lintCommand);

  return { filesWritten, filesMissing, lint, summary: loop.text, costUsd: loop.costUsd };
}

function buildPrompt(repoProfile: RepoProfile, blockSpec: BlockSpec, plan: Plan, allowedPaths: string[], feedback?: string): string {
  return `## Target repo
${repoProfile.digestMarkdown}

## Plan (already approved by a human — build exactly this)
${plan.summary}

Decision: ${plan.reuseDecision.decision}${plan.reuseDecision.targetBlock ? ` (target: ${plan.reuseDecision.targetBlock})` : ""}

Files you may write (nothing else):
${allowedPaths.map((p) => `- ${p}`).join("\n")}

DOM contract:
${plan.domContract}

Universal Editor fields:
${plan.ueFields.map((f) => `- ${f.name} (${f.component})${f.required ? " — required" : ""}: ${f.label}`).join("\n") || "(none)"}

Tokens to reuse: ${plan.tokensReused.join(", ") || "(none)"}
New tokens to define: ${plan.tokensNew.map((t) => `${t.name}: ${t.value}`).join(", ") || "(none)"}
${feedback ? `\n## Feedback from a previous verification attempt — fix this\n${feedback}\n` : ""}
Write the files now. Read a sibling block first to match conventions exactly, then run_lint before you finish.`;
}

/**
 * The Builder's tool surface: full read access, but writes/patches are restricted to the exact
 * files the approved plan named — enforced here, not just by prompt instruction, since a prompt
 * is not a security boundary.
 */
export function createBuilderTools(workspaceDir: string, repoProfile: RepoProfile, allowedPaths: string[]) {
  const base = createFsTools(workspaceDir);
  const blockTools = createBlockTools(workspaceDir, repoProfile);
  const lintTools = createRunLintTool(workspaceDir, repoProfile);

  const allowedSet = new Set(allowedPaths);
  const deny = (path: string) => ({
    error: `"${path}" is not in this job's approved file list. You may only write to:\n${allowedPaths.map((p) => `- ${p}`).join("\n")}`,
  });

  const fs_write = tool({
    description: base.fs_write.description,
    inputSchema: base.fs_write.inputSchema,
    execute: async (input: { path: string; content: string }, options) => {
      if (!allowedSet.has(input.path)) return deny(input.path);
      return base.fs_write.execute!(input, options);
    },
  });

  const fs_patch = tool({
    description: base.fs_patch.description,
    inputSchema: base.fs_patch.inputSchema,
    execute: async (input: { path: string; oldString: string; newString: string; replaceAll: boolean }, options) => {
      if (!allowedSet.has(input.path)) return deny(input.path);
      return base.fs_patch.execute!(input, options);
    },
  });

  return {
    fs_read: base.fs_read,
    fs_search: base.fs_search,
    fs_write,
    fs_patch,
    ...blockTools,
    ...lintTools,
  };
}
