import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildRepoProfile } from "../agents/cartographer/index.js";
import { extractAemRepository } from "../agents/cartographer/aem-extract.js";
import { computeCacheKey, isGitRepo } from "../agents/cartographer/extract.js";
import type { WorkspaceRepository } from "../db/repository.js";
import type { ModelRouter } from "../llm/router.js";
import type { RepoProfile } from "../schemas/repo-profile.js";

export interface EnsureWorkspaceOptions {
  workspaceId: string;
  rootPath: string;
  workspaces: WorkspaceRepository;
  /** When provided, the Cartographer's block-purpose enrichment pass runs; otherwise the profile is fully deterministic. */
  router?: ModelRouter;
  /** Force a rebuild even if the cached profile's cache key still matches. */
  force?: boolean;
}

/**
 * Points Blocksmith at an EDS repo folder. Builds a fresh RepoProfile on first use, and again
 * whenever the repo has changed since the last cached profile (git HEAD sha moved, or — for a
 * non-git folder — the content hash of blocks/styles/UE json changed). Cheap to call on every
 * request; the cache check itself is a stat/hash, not a rebuild.
 */
export async function ensureWorkspaceProfile({ workspaceId, rootPath, workspaces, router, force }: EnsureWorkspaceOptions): Promise<RepoProfile> {
  const resolvedRoot = resolve(rootPath);
  if (!existsSync(resolvedRoot)) {
    throw new Error(`Workspace path does not exist: ${resolvedRoot}`);
  }

  const gitRepo = isGitRepo(resolvedRoot);
  workspaces.upsert({ id: workspaceId, rootPath: resolvedRoot, isGitRepo: gitRepo });

  const existing = workspaces.get(workspaceId);
  const currentCacheKey = computeCacheKey(resolvedRoot);

  if (!force && existing?.repoProfile && existing.repoProfileCacheKey === currentCacheKey) {
    return existing.repoProfile;
  }

  const profile = await buildRepoProfile(resolvedRoot, router);
  workspaces.saveRepoProfile(workspaceId, profile, currentCacheKey);
  return profile;
}

export function refreshAemWorkspaceProfile(options: {
  workspaceId: string;
  workspaceDir: string;
  workspaces: WorkspaceRepository;
}): RepoProfile {
  const stored = options.workspaces.get(options.workspaceId);
  if (!stored?.repoProfile) {
    throw new Error(`Workspace ${options.workspaceId} has no repository profile to refresh`);
  }

  const extraction = extractAemRepository(options.workspaceDir);
  const profile: RepoProfile = {
    ...stored.repoProfile,
    generatedAt: new Date().toISOString(),
    modules: extraction.modules,
    aemArtifacts: extraction.artifacts,
    aemComponents: extraction.components,
    relationships: extraction.relationships,
  };
  options.workspaces.saveRepoProfile(options.workspaceId, profile, stored.repoProfileCacheKey ?? profile.cacheKey);
  return profile;
}
