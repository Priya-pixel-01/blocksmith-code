import { mkdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium } from "playwright";
import type { AxeScanResult } from "./axe.js";
import { BREAKPOINTS, type RenderResult } from "./render.js";
import { startStaticServer } from "./static-server.js";
import { resolveInSandbox } from "../tools/sandbox.js";

export async function renderGenericComponent(options: {
  workspaceDir: string;
  htmlPath: string;
  outDir: string;
}): Promise<RenderResult & { axe: AxeScanResult }> {
  await mkdir(options.outDir, { recursive: true });
  const htmlAbsolutePath = resolveInSandbox(options.workspaceDir, options.htmlPath);
  const htmlRelativePath = relative(resolve(options.workspaceDir), htmlAbsolutePath).replaceAll("\\", "/");
  const urlPath = htmlRelativePath.split("/").map(encodeURIComponent).join("/");
  const server = await startStaticServer(options.workspaceDir);
  const browser = await chromium.launch();

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await page.goto(`${server.baseUrl}/${urlPath}`, { waitUntil: "networkidle" });
    await page.evaluate("document.fonts.ready");

    const screenshots: RenderResult["screenshots"] = [];
    for (const breakpoint of BREAKPOINTS) {
      await page.setViewportSize({ width: breakpoint.width, height: 900 });
      const path = resolve(options.outDir, `${breakpoint.label}-${breakpoint.width}.png`);
      await page.screenshot({ path, fullPage: true });
      screenshots.push({ width: breakpoint.width, label: breakpoint.label, path });
    }

    const results = await new AxeBuilder({ page }).include("body").analyze();
    const axe: AxeScanResult = {
      violationCount: results.violations.length,
      violations: results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact ?? null,
        description: violation.description,
        nodeCount: violation.nodes.length,
      })),
      decorated: true,
    };

    return {
      screenshots,
      consoleErrors,
      decoratedHtml: await page.content(),
      decorated: true,
      axe,
    };
  } finally {
    await browser.close();
    await server.close();
  }
}
