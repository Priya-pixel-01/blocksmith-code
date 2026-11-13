import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { UeField } from "../schemas/block-spec.js";
import { openRenderSession } from "./session.js";

export const BREAKPOINTS = [
  { width: 375, label: "mobile" },
  { width: 768, label: "tablet" },
  { width: 1200, label: "desktop" },
] as const;

export interface RenderOptions {
  /** The job's isolated workspace directory — never the target repo root. */
  workspaceDir: string;
  blockName: string;
  ueFields: UeField[];
  outDir: string;
}

export interface RenderResult {
  screenshots: Array<{ width: number; label: string; path: string }>;
  consoleErrors: string[];
  decoratedHtml: string;
  /** False if the block never reached data-block-status="loaded" within the timeout — a real signal something is badly wrong (e.g. the block's JS never resolves), not just a lint-level issue. */
  decorated: boolean;
}

/** Renders a block through the repo's real page boot sequence (see session.ts) and screenshots it at three breakpoints. */
export async function renderBlock({ workspaceDir, blockName, ueFields, outDir }: RenderOptions): Promise<RenderResult> {
  await mkdir(outDir, { recursive: true });

  const session = await openRenderSession({ workspaceDir, blockName, ueFields });
  try {
    const screenshots: RenderResult["screenshots"] = [];
    for (const bp of BREAKPOINTS) {
      await session.page.setViewportSize({ width: bp.width, height: 900 });
      const path = join(outDir, `${bp.label}-${bp.width}.png`);
      await session.page.screenshot({ path, fullPage: true });
      screenshots.push({ width: bp.width, label: bp.label, path });
    }

    const decoratedHtml = await session.page.content();
    return { screenshots, consoleErrors: session.consoleErrors, decoratedHtml, decorated: session.decorated };
  } finally {
    await session.close();
  }
}
