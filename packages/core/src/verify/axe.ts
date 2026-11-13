import { AxeBuilder } from "@axe-core/playwright";
import type { UeField } from "../schemas/block-spec.js";
import { openRenderSession } from "./session.js";

export interface AxeViolation {
  id: string;
  impact: string | null;
  description: string;
  nodeCount: number;
}

export interface AxeScanResult {
  violationCount: number;
  violations: AxeViolation[];
  decorated: boolean;
}

export interface ScanAccessibilityOptions {
  workspaceDir: string;
  blockName: string;
  ueFields: UeField[];
}

/** Runs axe-core against the decorated block (scoped to the block's own subtree, not the whole synthetic page — the stubbed header/footer and page chrome aren't what's under test). */
export async function scanAccessibility({ workspaceDir, blockName, ueFields }: ScanAccessibilityOptions): Promise<AxeScanResult> {
  const session = await openRenderSession({ workspaceDir, blockName, ueFields });
  try {
    const results = await new AxeBuilder({ page: session.page }).include(`.${blockName}`).analyze();
    return {
      violationCount: results.violations.length,
      violations: results.violations.map((v) => ({
        id: v.id,
        impact: v.impact ?? null,
        description: v.description,
        nodeCount: v.nodes.length,
      })),
      decorated: session.decorated,
    };
  } finally {
    await session.close();
  }
}
