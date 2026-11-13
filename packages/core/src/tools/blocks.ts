import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import type { RepoProfile } from "../schemas/repo-profile.js";
import { resolveInSandbox } from "./sandbox.js";

/**
 * Shared block-introspection tools: list what already exists in the repo, and read one block's
 * real source. Used by both the Reuse Analyst (deciding create/extend/variant) and the Block
 * Builder (reading a sibling block's conventions before writing a new one, or reading the target
 * block's current source before extending it).
 */
export function createBlockTools(root: string, repoProfile: RepoProfile) {
  const list_blocks = tool({
    description: "List every block that already exists in this repo, with its purpose and known variants.",
    inputSchema: z.object({}),
    execute: async () => ({
      blocks: repoProfile.blocks.map((b) => ({
        name: b.name,
        purpose: b.purpose || "(no purpose recorded)",
        variants: b.variants,
        hasUeJson: b.hasUeJson,
      })),
    }),
  });

  const read_block = tool({
    description: "Read the full source (.js, .css, README, and _<name>.json UE fragment if present) of one existing block by name.",
    inputSchema: z.object({ name: z.string() }),
    execute: async ({ name }) => {
      const exists = repoProfile.blocks.some((b) => b.name === name);
      if (!exists) {
        return { error: `No block named "${name}" in this repo. Call list_blocks to see valid names.` };
      }
      const blockDir = resolveInSandbox(root, `blocks/${name}`);
      const files = await readdir(blockDir);
      const contents: Record<string, string> = {};
      for (const file of files) {
        contents[file] = await readFile(join(blockDir, file), "utf-8");
      }
      return { name, files: contents };
    },
  });

  return { list_blocks, read_block };
}
