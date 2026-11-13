import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestPdf } from "./pdf.js";

/**
 * Hand-builds a minimal single-page PDF with a real, correct xref table (byte offsets computed,
 * not guessed) so pdfjs-dist can parse it without a real PDF authoring tool in this test.
 * Rendering it visually is a known-imperfect case (bare Type1/Helvetica declarations without an
 * embedded font program hit a pdfjs standard-font substitution edge case — confirmed while
 * building the ingestor), so this test asserts on structure and text extraction, which do work
 * correctly, rather than on rendered pixel content.
 */
function buildMinimalPdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 20 100 Td (${text}) Tj ET`;
  const objs = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 300 150] /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];

  let out = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objs) {
    offsets.push(Buffer.byteLength(out));
    out += obj;
  }
  const xrefStart = Buffer.byteLength(out);
  out += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return Buffer.from(out, "binary");
}

test("ingestPdf extracts the text layer and rasterizes the page", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blocksmith-pdf-"));
  try {
    const pdfPath = join(dir, "brd.pdf");
    writeFileSync(pdfPath, buildMinimalPdf("Blocksmith BRD Test Page"));

    const artifact = await ingestPdf({ filePath: pdfPath, outDir: join(dir, "out") });

    assert.equal(artifact.kind, "pdf");
    assert.ok(artifact.textContent?.includes("Blocksmith BRD Test Page"), `got: ${artifact.textContent}`);
    assert.equal(artifact.images.length, 1);
    assert.ok(artifact.images[0]!.endsWith("page-01.png"));
    assert.ok(statSync(artifact.images[0]!).size > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
