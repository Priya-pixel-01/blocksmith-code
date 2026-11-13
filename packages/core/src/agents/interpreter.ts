import { readFile } from "node:fs/promises";
import type { ModelMessage } from "ai";
import { BlockSpecSchema, type BlockSpec } from "../schemas/block-spec.js";
import type { SourceArtifact } from "../schemas/source.js";
import type { RepoProfile } from "../schemas/repo-profile.js";
import type { ModelRouter } from "../llm/router.js";
import { validateUEFields } from "../schemas/field-validation.js";

const SYSTEM_PROMPT = `You are the Design Interpreter for Blocksmith, a tool that turns a design source (a Figma \
frame, a screenshot, or a page from a BRD PDF) into an Adobe Edge Delivery Services block for a \
SPECIFIC, real codebase.

CRITICAL: If human feedback on a rejected interpretation is provided, it represents explicit \
guidance on what needs to change. Acknowledge it in your openQuestions or intent field and ensure \
your revised BlockSpec addresses all points raised.

You will be given:
1. A profile of the target repo — its existing blocks, design tokens, real CSS breakpoints, and \
Universal Editor conventions.
2. The design source itself — as an image, and optionally extracted text (from a PDF) or a \
pruned Figma node tree (layout, fills, typography, text — geometry and effects already stripped).

Your job is to translate the design into a BlockSpec grounded in that specific repo:
- Propose a kebab-case block name.
- Define the Universal Editor fields an author would fill in — match the field vocabulary \
(component types: text, richtext, reference, select, boolean, number, container) the repo's \
existing blocks already use where the content type matches.

MANDATORY FIELD COLLAPSE RULES — VIOLATIONS WILL FAIL BUILD:
================================================================================
Adobe aem.live Universal Editor uses reserved suffixes to collapse multiple field values into 
ONE semantic HTML element. These rules are STRICTLY ENFORCED by xwalk linting.

RESERVED SUFFIXES (case-sensitive): Alt, Text, Title, Type, MimeType

PATTERN: BASE_FIELD + SUFFIX → Single HTML element with all values merged
  • "image" + "imageAlt" → <img src="..." alt="...">
  • "link" + "linkText" + "linkTitle" + "linkType" → <a href="..." title="...">TEXT</a>
  • "heading" + "headingType" → <h2>TEXT</h2> (h2 from headingType)

ABSOLUTE RULES — VIOLATING ANY OF THESE WILL CAUSE LINTING ERRORS:
  1. ✗ NEVER create suffix fields without their base
     Example WRONG: fields = ["buttonText", "buttonLink"] → ERROR (missing "button")
  2. ✓ ALWAYS pair suffixes with their base
     Example RIGHT: fields = ["button", "buttonText", "buttonLink"]
  3. ✗ NEVER orphan a suffix by itself
     Example WRONG: ["imageAlt"] without "image" → xwalk/no-orphan-collapsible-fields ERROR
  4. ✓ Field names must start with letter, contain only letters/numbers/_/-/: (no spaces)
  5. ✓ No duplicate field names in the same block
  6. ✓ Keep blocks ≤4 fields (use collapsing to reduce count — collapsed suffixes don't add cells)

EXAMPLES OF COMMON MISTAKES TO AVOID:
  • image + imageAlt ✓ CORRECT
  • imageAlt alone ✗ WRONG (xwalk/no-orphan-collapsible-fields)
  • button + buttonText + buttonLink ✓ CORRECT
  • buttonText + buttonLink ✗ WRONG (missing "button" base)
  • link-target + linkTarget ✓ CORRECT
  • linkTarget ✗ WRONG (missing base "link")

VALIDATION CHECKLIST — BEFORE RETURNING YOUR BLOCKSPEC:
  ✓ Step 1: List all fields in your ueFields array
  ✓ Step 2: For EACH field ending in Alt/Text/Title/Type/MimeType, verify the base field exists
     Example: if you have "buttonText", confirm "button" is also in the array
  ✓ Step 3: Verify all field names start with a letter and contain only alphanumeric/_/-/:
  ✓ Step 4: Confirm no duplicate field names
  ✓ Step 5: Count total fields; if >4, use more collapsing to reduce
  ✓ Step 6: If ANY check fails, revise your ueFields and try again BEFORE submitting

This validation WILL be run on your BlockSpec. If it fails, the job will retry with your error 
as feedback. By catching mistakes here, you save time and provide a better result on the first 
attempt.

- Describe the semantic DOM decorate() should produce, in the repo's own idiom.
- Express responsive behavior ONLY in terms of the repo's real breakpoints listed in the profile \
— never invent a breakpoint that isn't already used in the codebase.
- Map every distinct color/spacing/type value you observe in the design to an existing repo \
token when it's a close match; only mark a value "new" when there is genuinely no reasonable \
existing token for it.
- Note concrete accessibility requirements implied by the design (e.g. interactive controls, \
image alt text, heading level).
- If anything about the design is ambiguous or under-specified for implementation, put it in \
openQuestions rather than guessing — these are surfaced to a human before any code is written.`;

export interface InterpretDesignOptions {
  artifact: SourceArtifact;
  repoProfile: RepoProfile;
  router: ModelRouter;
  /** Human feedback from a rejected plan on a prior attempt, if this is a re-run. */
  feedback?: string;
}

export interface InterpretDesignResult {
  blockSpec: BlockSpec;
  costUsd: number | null;
}

export async function interpretDesign({ artifact, repoProfile, router, feedback }: InterpretDesignOptions): Promise<InterpretDesignResult> {
  const MAX_RETRIES = 3;
  let lastError: string | null = null;
  let currentFeedback = feedback;
  let totalCostUsd = 0;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const messages = await buildMessages(artifact, repoProfile, currentFeedback);

    const result = await router.generateStructured({
      role: "interpreter",
      schema: BlockSpecSchema,
      schemaName: "BlockSpec",
      system: SYSTEM_PROMPT,
      messages,
    });

    const blockSpec = result.object;
    if (result.costUsd) {
      totalCostUsd += result.costUsd;
    }
    
    // ENFORCE: Validate Universal Editor fields for orphan collapsible fields and other xwalk rules
    const validation = validateUEFields(blockSpec.ueFields);
    if (!validation.isValid) {
      const errorMessages = validation.errors
        .filter(e => e.severity === "error")
        .map(e => `  • ${e.fieldName}: ${e.error}`)
        .join("\n");
      
      lastError = 
        `Field validation failed:\n${errorMessages}\n\n` +
        `REQUIRED FIX:\n` +
        `  • Every field ending in Alt, Text, Title, Type, or MimeType MUST have a base field\n` +
        `  • Field names must start with letter, contain only letters/numbers/_/-/:\n` +
        `  • No duplicate field names\n` +
        `  • Keep blocks ≤4 fields (use field collapsing to reduce count)`;

      // If this is our last attempt, throw the error
      if (attempt === MAX_RETRIES) {
        throw new Error(
          `BlockSpec failed validation after ${MAX_RETRIES} attempts:\n${errorMessages}`
        );
      }

      // Otherwise, include the error as feedback and retry
      currentFeedback = lastError + (currentFeedback ? `\n\nPrior guidance: ${currentFeedback}` : "");
      // Silently retry; console.warn intentionally omitted to avoid user-facing logs
      continue;
    }

    // Validation passed! Return with accumulated cost
    return { blockSpec, costUsd: totalCostUsd || result.costUsd };
  }

  // Should never reach here, but failsafe
  throw new Error(lastError || "Interpreter failed after maximum retries");
}

async function buildMessages(artifact: SourceArtifact, repoProfile: RepoProfile, feedback?: string): Promise<ModelMessage[]> {
  const breakpointList = repoProfile.tokens.breakpoints.map((b) => `${b.mediaQuery} (${b.description})`).join(", ") || "(no responsive breakpoints detected)";

  const contextParts: string[] = [];
  
  // Feedback first, if present
  if (feedback) {
    contextParts.push(`## HUMAN FEEDBACK FROM REJECTED INTERPRETATION — THIS IS MANDATORY TO ADDRESS\n\n${feedback}`);
  }

  contextParts.push(
    `## Target repo profile\n\n${repoProfile.digestMarkdown}`,
    `## Real breakpoints available to you\n${breakpointList}`,
  );

  if (artifact.textContent) {
    contextParts.push(`## Extracted text from the source (${artifact.kind})\n\n${artifact.textContent.slice(0, 8000)}`);
  }
  if (artifact.structured) {
    contextParts.push(`## Pruned Figma node tree\n\n\`\`\`json\n${JSON.stringify(artifact.structured).slice(0, 12000)}\n\`\`\``);
  }

  contextParts.push(`## Source origin\n${artifact.originGeoRef}`);

  const content: Array<{ type: "text"; text: string } | { type: "file"; data: Buffer; mediaType: string }> = [
    { type: "text", text: contextParts.join("\n\n") },
  ];

  for (const imagePath of artifact.images) {
    const buffer = await readFile(imagePath);
    content.push({ type: "file", data: buffer, mediaType: "image/png" });
  }

  return [{ role: "user", content }];
}
