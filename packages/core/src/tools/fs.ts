import { tool } from "ai";
import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveInSandbox, toPosixRelative } from "./sandbox.js";

const execFileAsync = promisify(execFile);

const MAX_READ_BYTES = 512 * 1024; // 512 KiB — plenty for source files, guards against accidental huge reads
const MAX_LIST_ENTRIES = 2000;

/**
 * Builds the filesystem tool set scoped to a single job workspace root.
 * Every path argument from the model is untrusted input and is routed through
 * resolveInSandbox before touching disk.
 */
export function createFsTools(root: string) {
  const fs_list = tool({
    description:
      "List files and directories under a path relative to the workspace root. Directories are suffixed with '/'.",
    inputSchema: z.object({
      path: z.string().default(".").describe("Path relative to workspace root, e.g. 'blocks' or '.' for root."),
      recursive: z.boolean().default(false),
    }),
    execute: async ({ path, recursive }) => {
      const absDir = resolveInSandbox(root, path);
      const entries: string[] = [];

      async function walk(dir: string) {
        const items = await readdir(dir, { withFileTypes: true });
        for (const item of items) {
          if (item.name === "node_modules" || item.name === ".git") continue;
          const abs = join(dir, item.name);
          const rel = toPosixRelative(root, abs);
          if (item.isDirectory()) {
            entries.push(`${rel}/`);
            if (recursive && entries.length < MAX_LIST_ENTRIES) await walk(abs);
          } else {
            entries.push(rel);
          }
          if (entries.length >= MAX_LIST_ENTRIES) return;
        }
      }

      await walk(absDir);
      return { entries, truncated: entries.length >= MAX_LIST_ENTRIES };
    },
  });

  const fs_read = tool({
    description: "Read a text file's contents, relative to the workspace root.",
    inputSchema: z.object({
      path: z.string(),
    }),
    execute: async ({ path }) => {
      const abs = resolveInSandbox(root, path);
      const info = await stat(abs);
      if (info.size > MAX_READ_BYTES) {
        return { error: `File is ${info.size} bytes, exceeds the ${MAX_READ_BYTES}-byte read limit. Use fs_search to locate the relevant section instead.` };
      }
      const content = await readFile(abs, "utf-8");
      return { path, content };
    },
  });

  const fs_write = tool({
    description: "Create or overwrite a file with the given content, relative to the workspace root. Creates parent directories as needed.",
    inputSchema: z.object({
      path: z.string(),
      content: z.string(),
    }),
    execute: async ({ path, content }) => {
      const abs = resolveInSandbox(root, path);
      await mkdir(dirname(abs), { recursive: true });
      // Some models return literal escape sequences (e.g., "\\r\\n") in JSON tool calls instead of
      // actual newlines — unescape them so the written files have proper line breaks.
      const normalized = content
        .replace(/\\r\\n/g, "\r\n")
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
      await writeFile(abs, normalized, "utf-8");
      return { path, bytesWritten: Buffer.byteLength(normalized, "utf-8") };
    },
  });

  const fs_patch = tool({
    description:
      "Replace an exact substring within an existing file. Fails if oldString is not found, or is not unique unless replaceAll is set — mirrors a find-and-replace edit, not a diff/patch format.",
    inputSchema: z.object({
      path: z.string(),
      oldString: z.string(),
      newString: z.string(),
      replaceAll: z.boolean().default(false),
    }),
    execute: async ({ path, oldString, newString, replaceAll }) => {
      const abs = resolveInSandbox(root, path);
      const content = await readFile(abs, "utf-8");
      
      // Normalize escape sequences in search/replace strings
      const normalizeEscapes = (s: string) => s
        .replace(/\\r\\n/g, "\r\n")
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
      
      const normalizedOld = normalizeEscapes(oldString);
      const normalizedNew = normalizeEscapes(newString);
      
      const occurrences = content.split(normalizedOld).length - 1;
      if (occurrences === 0) {
        return { error: `oldString not found in ${path}` };
      }
      if (occurrences > 1 && !replaceAll) {
        return { error: `oldString occurs ${occurrences} times in ${path}; pass replaceAll:true or provide more context to make it unique` };
      }
      const updated = replaceAll ? content.split(normalizedOld).join(normalizedNew) : content.replace(normalizedOld, normalizedNew);
      await writeFile(abs, updated, "utf-8");
      return { path, replacements: replaceAll ? occurrences : 1 };
    },
  });

  const fs_search = tool({
    description: "Search file contents for a regex pattern under the workspace root (ripgrep-backed). Returns matching file:line:text.",
    inputSchema: z.object({
      pattern: z.string(),
      path: z.string().default(".").describe("Subdirectory to search within, relative to workspace root."),
      glob: z.string().nullable().describe("Optional glob filter, e.g. '*.css'."),
      maxResults: z.number().int().min(1).max(500).default(100),
    }),
    execute: async ({ pattern, path, glob, maxResults }) => {
      const absDir = resolveInSandbox(root, path);
      const args = ["--line-number", "--no-heading", "--color", "never", "-e", pattern];
      if (glob) args.push("--glob", glob);
      args.push("--max-count", String(maxResults), absDir, "--glob", "!node_modules", "--glob", "!.git");
      try {
        const { stdout } = await execFileAsync("rg", args, { maxBuffer: 4 * 1024 * 1024 });
        const lines = stdout.split("\n").filter(Boolean).slice(0, maxResults);
        return { matches: lines.map((line) => line.replace(absDir + "/", "").replace(absDir, ".")) };
      } catch (err: unknown) {
        const e = err as { code?: number; stdout?: string };
        if (e.code === 1) return { matches: [] }; // rg exit 1 = no matches, not an error
        throw err;
      }
    },
  });

  return { fs_list, fs_read, fs_write, fs_patch, fs_search };
}
