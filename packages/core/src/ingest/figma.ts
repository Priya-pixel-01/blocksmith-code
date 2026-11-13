import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SourceArtifact } from "../schemas/source.js";
import type { FigmaCacheRepository } from "../db/repository.js";

const FIGMA_API_BASE = "https://api.figma.com/v1";

// Raw Figma node JSON is enormous (every vector path, every effect, empty groups). Pruning keeps
// only what actually determines an EDS block's layout and content, capped so the pruned tree
// stays well within a vision model's context regardless of design complexity.
const MAX_PRUNED_NODES = 400;
const KEPT_LAYOUT_KEYS = [
  "layoutMode",
  "primaryAxisAlignItems",
  "counterAxisAlignItems",
  "itemSpacing",
  "paddingLeft",
  "paddingRight",
  "paddingTop",
  "paddingBottom",
  "constraints",
  "layoutSizingHorizontal",
  "layoutSizingVertical",
];
const KEPT_STYLE_KEYS = ["fills", "strokes", "cornerRadius", "opacity"];
const KEPT_TEXT_KEYS = ["characters", "style"];

export interface FigmaRef {
  fileKey: string;
  nodeId: string | null;
}

/**
 * Parses both current Figma URL shapes:
 *   https://www.figma.com/file/<fileKey>/<name>?node-id=<id>
 *   https://www.figma.com/design/<fileKey>/<name>?node-id=<id>
 * node-id in the URL uses "-" as a separator (e.g. "123-456"); the API wants "123:456".
 */
export function parseFigmaUrl(url: string): FigmaRef {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/\/(file|design)\/([a-zA-Z0-9]+)/);
  if (!match) {
    throw new Error(`Could not parse a Figma file key from URL: ${url}`);
  }
  const fileKey = match[2]!;

  const rawNodeId = parsed.searchParams.get("node-id");
  const nodeId = rawNodeId ? rawNodeId.replace(/-/g, ":") : null;

  return { fileKey, nodeId };
}

/** Builds a normalized Figma URL for caching (consistent format regardless of input URL style) */
export function buildNormalizedUrl(fileKey: string, nodeId: string | null): string {
  const base = `https://www.figma.com/file/${fileKey}`;
  return nodeId ? `${base}?node-id=${nodeId}` : base;
}

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  characters?: string;
  [key: string]: unknown;
}

/** Strips vector geometry, effects, and other layout-irrelevant noise; caps total node count. */
export function pruneNodeTree(node: FigmaNode, budget = { remaining: MAX_PRUNED_NODES }): FigmaNode | null {
  if (budget.remaining <= 0) return null;
  budget.remaining -= 1;

  const pruned: FigmaNode = { id: node.id, name: node.name, type: node.type };

  for (const key of KEPT_LAYOUT_KEYS) if (key in node) pruned[key] = node[key];
  for (const key of KEPT_STYLE_KEYS) if (key in node) pruned[key] = node[key];
  for (const key of KEPT_TEXT_KEYS) if (key in node) pruned[key] = node[key];
  if ("absoluteBoundingBox" in node) pruned.absoluteBoundingBox = node.absoluteBoundingBox;

  if (node.children && node.children.length > 0) {
    const kept = node.children.map((child) => pruneNodeTree(child, budget)).filter((c): c is FigmaNode => c !== null);
    if (kept.length > 0) pruned.children = kept;
  }

  return pruned;
}

export interface FigmaIngestOptions {
  url: string;
  token: string;
  outDir: string;
  cache?: FigmaCacheRepository;
  force?: boolean;
}

export async function ingestFigma({ url, token, outDir, cache, force }: FigmaIngestOptions): Promise<SourceArtifact> {
  const { fileKey, nodeId } = parseFigmaUrl(url);
  const normalizedUrl = buildNormalizedUrl(fileKey, nodeId);
  
  // Check cache if available and not forcing refresh
  if (cache && !force) {
    const cached = cache.get(normalizedUrl);
    if (cached) {
      const cachedImages = cached.artifact.images ?? [];
      const hasAllImages = await allPathsExist(cachedImages);
      if (hasAllImages) {
        return cached.artifact;
      }

      // Stale cache can contain absolute paths from a previous machine/workspace.
      cache.delete(normalizedUrl);
    }
  }

  await mkdir(outDir, { recursive: true });

  const headers = { "X-Figma-Token": token };

  const nodesRes = await fetch(`${FIGMA_API_BASE}/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId ?? "")}`, { headers });
  if (!nodesRes.ok) {
    throw new Error(`Figma API error fetching node tree (HTTP ${nodesRes.status}): ${await safeText(nodesRes)}`);
  }
  const nodesBody = (await nodesRes.json()) as { nodes: Record<string, { document: FigmaNode }> };
  const targetKey = nodeId ?? Object.keys(nodesBody.nodes)[0];
  const document = targetKey ? nodesBody.nodes[targetKey]?.document : undefined;
  if (!document) {
    throw new Error(`Figma node ${nodeId ?? "(file root)"} not found in file ${fileKey}`);
  }
  const pruned = pruneNodeTree(document);

  const imageUrl = `${FIGMA_API_BASE}/images/${fileKey}?ids=${encodeURIComponent(nodeId ?? document.id)}&format=png&scale=2`;
  const imagesRes = await fetch(imageUrl, { headers });
  if (!imagesRes.ok) {
    throw new Error(`Figma API error rendering image (HTTP ${imagesRes.status}): ${await safeText(imagesRes)}`);
  }
  const imagesBody = (await imagesRes.json()) as { images: Record<string, string | null> };
  const renderedUrl = Object.values(imagesBody.images).find((u): u is string => Boolean(u));

  const images: string[] = [];
  if (renderedUrl) {
    const imgRes = await fetch(renderedUrl);
    if (imgRes.ok) {
      const buffer = Buffer.from(await imgRes.arrayBuffer());
      const outPath = join(outDir, "frame.png");
      await writeFile(outPath, buffer);
      images.push(outPath);
    }
  }

  const artifact: SourceArtifact = {
    kind: "figma",
    originGeoRef: url,
    textContent: null,
    images,
    structured: pruned,
  };

  // Save to cache if available
  if (cache) {
    cache.set(normalizedUrl, artifact, images[0] ?? null);
  }

  return artifact;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "(no body)";
  }
}

async function allPathsExist(paths: string[]): Promise<boolean> {
  try {
    await Promise.all(paths.map((p) => access(p)));
    return true;
  } catch {
    return false;
  }
}
