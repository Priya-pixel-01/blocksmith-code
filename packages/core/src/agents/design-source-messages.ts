import { readFile } from "node:fs/promises";
import type { ModelMessage } from "ai";
import type { SourceArtifact } from "../schemas/source.js";

export async function designSourceMessages(prompt: string, artifact: SourceArtifact): Promise<ModelMessage[]> {
  const context = [
    prompt,
    `## Original design source (${artifact.kind})\n${artifact.originGeoRef}`,
    artifact.textContent ? `## Extracted source text\n${artifact.textContent.slice(0, 8000)}` : "",
    artifact.structured ? `## Structured source details\n${JSON.stringify(artifact.structured).slice(0, 12000)}` : "",
  ].filter(Boolean);
  const content: Array<{ type: "text"; text: string } | { type: "file"; data: Buffer; mediaType: string }> = [
    { type: "text", text: context.join("\n\n") },
  ];

  for (const [index, imagePath] of artifact.images.entries()) {
    content.push({ type: "text", text: `## Original design image ${index + 1}` });
    content.push({ type: "file", data: await readFile(imagePath), mediaType: "image/png" });
  }

  return [{ role: "user", content }];
}
