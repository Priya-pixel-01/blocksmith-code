import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { ingestImage } from "./image.js";

async function makeTestPng(path: string, width: number, height: number) {
  await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 50, b: 50 } },
  })
    .png()
    .toFile(path);
}

test("ingestImage downsizes an oversized image to fit within the vision-friendly cap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blocksmith-image-"));
  try {
    const inputPath = join(dir, "big.png");
    await makeTestPng(inputPath, 3000, 1500);

    const artifact = await ingestImage({ filePath: inputPath, outDir: dir });
    assert.equal(artifact.kind, "image");
    assert.equal(artifact.images.length, 1);

    const meta = await sharp(artifact.images[0]!).metadata();
    assert.ok((meta.width ?? 0) <= 2000, `expected width <= 2000, got ${meta.width}`);
    assert.ok((meta.height ?? 0) <= 2000, `expected height <= 2000, got ${meta.height}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ingestImage leaves a small image's dimensions unchanged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blocksmith-image-"));
  try {
    const inputPath = join(dir, "small.png");
    await makeTestPng(inputPath, 400, 300);

    const artifact = await ingestImage({ filePath: inputPath, outDir: dir });
    const meta = await sharp(artifact.images[0]!).metadata();
    assert.equal(meta.width, 400);
    assert.equal(meta.height, 300);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
