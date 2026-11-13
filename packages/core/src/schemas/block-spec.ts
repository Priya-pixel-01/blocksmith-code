import { z } from "zod";

/** Design Interpreter output: what the design *means* as an EDS block, mapped onto the real repo. */

export const UeFieldSchema = z.object({
  name: z.string(),
  component: z.enum(["text", "richtext", "reference", "select", "boolean", "number", "container"]),
  valueType: z.string().nullable(),
  label: z.string(),
  required: z.boolean().default(false),
  options: z.array(z.object({ name: z.string(), value: z.string() })).nullable(),
});
export type UeField = z.infer<typeof UeFieldSchema>;

export const TokenMappingSchema = z.object({
  designValue: z.string().describe("Raw value observed in the source design, e.g. '#1473E6' or '24px'."),
  mappedToken: z.string().nullable().describe("Existing repo custom property this maps to, e.g. '--link-color'. Null if no close match."),
  isNew: z.boolean().describe("True if this value has no reasonable match in the repo's existing tokens and should be added."),
});
export type TokenMapping = z.infer<typeof TokenMappingSchema>;

export const BlockSpecSchema = z.object({
  blockNameCandidate: z.string().describe("kebab-case candidate name, e.g. 'testimonial-carousel'."),
  intent: z.string().describe("One or two sentences: what this block is for."),
  ueFields: z.array(UeFieldSchema),
  domContract: z.string().describe("Markdown description of the semantic DOM decorate() should produce."),
  responsive: z.array(
    z.object({
      breakpoint: z.string().describe("Must be one of the repo's real breakpoints from RepoProfile.tokens.breakpoints, not invented."),
      behavior: z.string(),
    }),
  ),
  variants: z.array(z.string()).describe("Block-option variants this design implies, e.g. 'dark', 'compact'."),
  tokenMapping: z.array(TokenMappingSchema),
  a11y: z.array(z.string()).describe("Specific accessibility requirements, e.g. 'carousel controls must be keyboard-operable'."),
  openQuestions: z.array(z.string()).describe("Anything ambiguous in the source that should be surfaced to the human rather than guessed."),
});
export type BlockSpec = z.infer<typeof BlockSpecSchema>;
