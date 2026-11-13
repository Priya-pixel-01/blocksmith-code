import { realpathSync } from "node:fs";
import { resolve, relative, isAbsolute, sep } from "node:path";

export class SandboxViolationError extends Error {
  constructor(root: string, attempted: string) {
    super(`Path "${attempted}" escapes sandbox root "${root}"`);
    this.name = "SandboxViolationError";
  }
}

/**
 * Resolves `relativePath` against `root` and asserts the result stays inside `root`.
 * Every fs tool must route through this before touching disk — it is the only thing
 * standing between an agent's tool call and the rest of the filesystem.
 *
 * Rejects absolute paths, `..` traversal, and symlinks that resolve outside root.
 */
export function resolveInSandbox(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) {
    throw new SandboxViolationError(root, relativePath);
  }

  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, relativePath);
  const rel = relative(resolvedRoot, candidate);

  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new SandboxViolationError(root, relativePath);
  }

  // Defend against symlinks inside the workspace that point outside it. If the path doesn't
  // exist yet (e.g. a write target, or a backup destination whose whole directory chain has
  // yet to be created), walk up looking for the deepest existing ancestor to realpath-check —
  // but never past `resolvedRoot` itself. Root (and everything below it) not existing yet is
  // normal and safe: with nothing on disk there, there's no symlink to have escaped through.
  // Walking past root to realpath some unrelated existing grandparent directory (e.g. the
  // target repo itself, several levels above a not-yet-created backup dir) would otherwise
  // false-positive as an escape purely because that grandparent sits outside `resolvedRoot`.
  let toCheck = candidate;
  while (true) {
    try {
      const real = realpathSync(toCheck);
      const realRel = relative(resolvedRoot, real);
      if (realRel.startsWith("..") || isAbsolute(realRel)) {
        throw new SandboxViolationError(root, relativePath);
      }
      break;
    } catch (err) {
      if (err instanceof SandboxViolationError) throw err;
      if (toCheck === resolvedRoot) break; // root itself doesn't exist yet — nothing above it to check
      const parent = resolve(toCheck, "..");
      if (parent === toCheck) break; // reached filesystem root without finding an existing ancestor
      toCheck = parent;
    }
  }

  return candidate;
}

/** True if `relativePath`, once resolved, falls under one of `allowedDirs` (also relative to root). */
export function isWithinAllowlist(root: string, relativePath: string, allowedDirs: string[]): boolean {
  const resolvedRoot = resolve(root);
  const candidate = resolveInSandbox(root, relativePath);
  return allowedDirs.some((dir) => {
    const allowedAbs = resolve(resolvedRoot, dir);
    const rel = relative(allowedAbs, candidate);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

export function toPosixRelative(root: string, absolutePath: string): string {
  return relative(resolve(root), absolutePath).split(sep).join("/");
}
