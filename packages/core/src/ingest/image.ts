import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import type { SourceArtifact } from "../schemas/source.js";

// Vision models trade off legibility against token cost roughly log-linearly with resolution;
// beyond ~2000px on the long edge you're mostly paying for detail models rarely use.
const MAX_DIMENSION = 2000;

export interface ImageIngestOptions {
  filePath: string;
  outDir: string;
}

/** Normalizes an uploaded design screenshot to a vision-friendly PNG. */
export async function ingestImage({ filePath, outDir }: ImageIngestOptions): Promise<SourceArtifact> {
  await mkdir(outDir, { recursive: true });

  const outPath = join(outDir, "source.png");
  const image = sharp(filePath).rotate(); // rotate() with no args auto-orients from EXIF, then strips it
  const metadata = await image.metadata();

  const needsResize = (metadata.width ?? 0) > MAX_DIMENSION || (metadata.height ?? 0) > MAX_DIMENSION;
  const pipeline = needsResize
    ? image.resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: "inside", withoutEnlargement: true })
    : image;

  await pipeline.png().toFile(outPath);

  return {
    kind: "image",
    originGeoRef: filePath,
    textContent: null,
    images: [outPath],
    structured: null,
  };
}
