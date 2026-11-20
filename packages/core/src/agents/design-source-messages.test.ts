import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceArtifact } from "../schemas/source.js";
import { designSourceMessages } from "./design-source-messages.js";

test("designSourceMessages attaches original design image and Figma structure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "blocksmith-design-source-"));
  const imagePath = join(directory, "design.png");
  const imageBytes = Buffer.from([137, 80, 78, 71]);
  await writeFile(imagePath, imageBytes);
  const artifact: SourceArtifact = {
    kind: "figma",
    originGeoRef: "https://figma.example/design",
    textContent: null,
    images: [imagePath],
    structured: { name: "Hero", width: 1200 },
  };

  try {
    const [message] = await designSourceMessages("Implement the approved plan.", artifact);
    assert.ok(message?.role === "user");
    if (message.role !== "user") throw new Error("Expected a user message");
    assert.ok(Array.isArray(message.content));
    if (!Array.isArray(message.content)) throw new Error("Expected multimodal user content");
    assert.ok(message.content.some((part) => part.type === "text" && part.text.includes("Implement the approved plan.")));
    assert.ok(message.content.some((part) => part.type === "text" && part.text.includes('"width":1200')));
    const image = message.content.find((part) => part.type === "file");
    assert.ok(image?.type === "file");
    assert.equal(image.mediaType, "image/png");
    assert.ok(image.data instanceof Uint8Array);
    assert.deepEqual(image.data, imageBytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
