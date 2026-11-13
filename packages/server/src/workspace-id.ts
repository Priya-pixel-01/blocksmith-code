import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** Deterministic id from a resolved folder path, so re-pointing at the same folder reuses the same workspace record. */
export function workspaceIdFor(rootPath: string): string {
  const hash = createHash("sha1").update(resolve(rootPath)).digest("hex").slice(0, 16);
  return `ws_${hash}`;
}
