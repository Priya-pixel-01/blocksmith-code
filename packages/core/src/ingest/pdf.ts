import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCanvas } from "canvas";
import type { SourceArtifact } from "../schemas/source.js";

// pdfjs-dist ships no package.json "exports" map, so the Node-compatible legacy build is
// imported by path. Node-canvas (not @napi-rs/canvas) is required here: pdfjs's text-painting
// path constructs Path2D objects in a way @napi-rs/canvas's Path2D implementation doesn't fully
// support, which throws mid-render — confirmed by hand while building this ingestor.
const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

const PDFJS_DIST_DIR = resolve(import.meta.dirname, "../../../../node_modules/pdfjs-dist");
const RENDER_SCALE = 2; // ~144dpi equivalent, legible for a vision model without huge file sizes
const MAX_PAGES = 20; // BRDs beyond this are summarized from text; rasterizing dozens of pages rarely adds signal

export interface PdfIngestOptions {
  filePath: string;
  outDir: string;
}

/** Extracts the text layer and rasterizes each page (up to MAX_PAGES) of a BRD-style PDF. */
export async function ingestPdf({ filePath, outDir }: PdfIngestOptions): Promise<SourceArtifact> {
  await mkdir(outDir, { recursive: true });
  const data = await readFile(filePath);

  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(data),
    standardFontDataUrl: `${PDFJS_DIST_DIR}/standard_fonts/`,
    cMapUrl: `${PDFJS_DIST_DIR}/cmaps/`,
    cMapPacked: true,
  }).promise;

  const pageCount = Math.min(doc.numPages, MAX_PAGES);
  const textParts: string[] = [];
  const images: string[] = [];

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const page = await doc.getPage(pageNum);

    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item) => ("str" in item ? item.str : "")).join(" ");
    textParts.push(pageText);

    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext("2d");
    // pdfjs-dist's browser-oriented types expect a DOM CanvasRenderingContext2D; node-canvas's
    // context implements the same drawing API pdfjs actually calls, so this cast is safe.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await page.render({ canvasContext: ctx as any, viewport }).promise;

    const imagePath = join(outDir, `page-${String(pageNum).padStart(2, "0")}.png`);
    await writeFile(imagePath, canvas.toBuffer("image/png"));
    images.push(imagePath);
  }

  return {
    kind: "pdf",
    originGeoRef: filePath,
    textContent: textParts.join("\n\n").trim() || null,
    images,
    structured: null,
  };
}
