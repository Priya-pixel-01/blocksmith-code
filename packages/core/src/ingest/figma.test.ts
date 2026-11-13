import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFigmaUrl, pruneNodeTree, ingestFigma } from "./figma.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("parseFigmaUrl handles the /file/ URL shape with a dashed node-id", () => {
  const ref = parseFigmaUrl("https://www.figma.com/file/abc123XYZ/My-Design?node-id=42-108");
  assert.equal(ref.fileKey, "abc123XYZ");
  assert.equal(ref.nodeId, "42:108");
});

test("parseFigmaUrl handles the newer /design/ URL shape", () => {
  const ref = parseFigmaUrl("https://www.figma.com/design/abc123XYZ/My-Design?node-id=42-108&t=xyz");
  assert.equal(ref.fileKey, "abc123XYZ");
  assert.equal(ref.nodeId, "42:108");
});

test("parseFigmaUrl returns null nodeId when the URL has none (whole file)", () => {
  const ref = parseFigmaUrl("https://www.figma.com/file/abc123XYZ/My-Design");
  assert.equal(ref.nodeId, null);
});

test("parseFigmaUrl throws a clear error for a non-Figma URL", () => {
  assert.throws(() => parseFigmaUrl("https://example.com/not-figma"), /Could not parse a Figma file key/);
});

test("pruneNodeTree keeps layout, fill, and text fields but drops unknown/geometry noise", () => {
  const raw = {
    id: "1:1",
    name: "Frame",
    type: "FRAME",
    layoutMode: "VERTICAL",
    itemSpacing: 16,
    fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }],
    strokeGeometry: [{ path: "M0 0 L100 100" }], // should be dropped — not in the keep-list
    effects: [{ type: "DROP_SHADOW" }], // should be dropped
    vectorNetwork: { vertices: [] }, // should be dropped
    children: [
      {
        id: "1:2",
        name: "Title",
        type: "TEXT",
        characters: "Hello world",
        style: { fontSize: 24 },
      },
    ],
  };

  const pruned = pruneNodeTree(raw as never);
  assert.ok(pruned);
  assert.equal(pruned.layoutMode, "VERTICAL");
  assert.equal(pruned.itemSpacing, 16);
  assert.ok(pruned.fills);
  assert.equal("strokeGeometry" in pruned, false);
  assert.equal("effects" in pruned, false);
  assert.equal("vectorNetwork" in pruned, false);
  assert.equal(pruned.children?.[0]?.characters, "Hello world");
});

test("pruneNodeTree caps total nodes under a deeply nested tree", () => {
  // Build a chain of 1000 nested single-child nodes.
  let leaf: Record<string, unknown> = { id: "leaf", name: "leaf", type: "RECTANGLE" };
  for (let i = 0; i < 1000; i++) {
    leaf = { id: `n${i}`, name: `n${i}`, type: "FRAME", children: [leaf] };
  }

  const pruned = pruneNodeTree(leaf as never);
  let count = 0;
  let cursor: typeof pruned = pruned;
  while (cursor) {
    count++;
    cursor = cursor.children?.[0] ?? null;
  }
  assert.ok(count <= 400, `expected pruning to cap at 400 nodes, got ${count}`);
});

function withStubbedFetch<T>(handler: (url: string) => Response, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => handler(String(input))) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

test("ingestFigma fetches the node tree and rendered image, and writes the frame PNG to outDir", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "blocksmith-figma-"));
  try {
    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes, enough for this test

    await withStubbedFetch(
      (url) => {
        if (url.includes("/files/")) {
          return new Response(
            JSON.stringify({
              nodes: {
                "42:108": { document: { id: "42:108", name: "Hero", type: "FRAME", layoutMode: "VERTICAL" } },
              },
            }),
            { status: 200 },
          );
        }
        if (url.includes("/images/")) {
          return new Response(JSON.stringify({ images: { "42:108": "https://figma-renders.example/frame.png" } }), { status: 200 });
        }
        if (url.includes("figma-renders.example")) {
          return new Response(fakePng, { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
      async () => {
        const artifact = await ingestFigma({
          url: "https://www.figma.com/design/abc123/My-Design?node-id=42-108",
          token: "test-token",
          outDir,
        });

        assert.equal(artifact.kind, "figma");
        assert.equal(artifact.images.length, 1);
        assert.ok(artifact.images[0]!.endsWith("frame.png"));
        assert.ok(artifact.structured);
      },
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
