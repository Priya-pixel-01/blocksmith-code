import { z } from "zod";

/** Common shape every ingestor (Figma / image / PDF) normalizes into. */
export const SourceArtifactSchema = z.object({
  kind: z.enum(["figma", "image", "pdf"]),
  originGeoRef: z.string().describe("Figma URL, uploaded filename, etc — for display and provenance."),
  textContent: z.string().nullable().describe("Extracted prose, e.g. a BRD's text layer. Null for pure visual sources."),
  images: z.array(z.string()).describe("Absolute file paths to rendered/rasterized PNGs, ready to pass to a vision model."),
  structured: z.unknown().nullable().describe("Pruned Figma node tree, when kind === 'figma'."),
});
export type SourceArtifact = z.infer<typeof SourceArtifactSchema>;
