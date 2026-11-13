import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { nanoid } from "nanoid";
import type { UeField } from "../schemas/block-spec.js";
import { startStaticServer, type StaticServerHandle } from "./static-server.js";
import { buildAuthoringDom, buildPageHtml, PLACEHOLDER_IMAGE_SVG } from "./authoring-dom.js";

const DECORATION_TIMEOUT_MS = 15_000;

export interface RenderSessionOptions {
  /** The job's isolated workspace directory — never the target repo root. */
  workspaceDir: string;
  blockName: string;
  ueFields: UeField[];
}

export interface RenderSession {
  page: Page;
  consoleErrors: string[];
  /** False if the block never reached data-block-status="loaded" within the timeout. */
  decorated: boolean;
  close: () => Promise<void>;
}

/**
 * Shared setup behind both renderBlock (screenshots) and scanAccessibility (axe-core): serves
 * the isolated workspace statically, builds the pre-decoration authoring DOM, and loads it
 * through the repo's real scripts/scripts.js boot sequence so the block is decorated exactly as
 * it would be in production — see render.ts for why that's the right approach rather than
 * importing the block module and calling decorate() directly. Callers get back a live Page
 * already past decoration (or timed out waiting for it) to do their own work against, plus a
 * `close()` that tears down the browser, static server, and temp files written into the
 * workspace.
 */
export async function openRenderSession({ workspaceDir, blockName, ueFields }: RenderSessionOptions): Promise<RenderSession> {
  const runId = nanoid(8);
  const renderFileName = `__blocksmith_render_${runId}.html`;
  const placeholderFileName = `__blocksmith_placeholder_${runId}.svg`;

  const authoringHtml = buildAuthoringDom(blockName, ueFields, `/${placeholderFileName}`);
  const pageHtml = buildPageHtml(blockName, authoringHtml, ["/styles/styles.css"]);
  const renderFilePath = join(workspaceDir, renderFileName);
  const placeholderFilePath = join(workspaceDir, placeholderFileName);
  await writeFile(renderFilePath, pageHtml, "utf-8");
  await writeFile(placeholderFilePath, PLACEHOLDER_IMAGE_SVG, "utf-8");

  const server = await startStaticServer(workspaceDir);
  const browser = await chromium.launch();

  const cleanupFiles = async () => {
    await unlink(renderFilePath).catch(() => {});
    await unlink(placeholderFilePath).catch(() => {});
  };

  try {
    // An explicit context (rather than the implicit one browser.newPage() creates) is required
    // by @axe-core/playwright's script-injection approach — it errors otherwise.
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on("pageerror", (err) => consoleErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    // aem.js's loadLazy() unconditionally loads header/footer as blocks too — real site
    // infrastructure, not what this harness is verifying, and their own code fetches separate
    // authored nav/footer content (/nav.plain.html etc.) this harness has no reason to provide.
    // Stubbing them out at the network level (rather than trying to satisfy their real fragment-
    // fetching logic with fake content) keeps this render scoped to the one block under test.
    if (blockName !== "header") {
      await page.route("**/blocks/header/header.js", (route) =>
        route.fulfill({ status: 200, contentType: "text/javascript", body: "export default async function decorate() {}" }),
      );
    }
    if (blockName !== "footer") {
      await page.route("**/blocks/footer/footer.js", (route) =>
        route.fulfill({ status: 200, contentType: "text/javascript", body: "export default async function decorate() {}" }),
      );
    }

    await page.goto(`${server.baseUrl}/${renderFileName}`, { waitUntil: "load" });

    const decorated = await page
      .waitForSelector(`.${blockName}[data-block-status="loaded"]`, { timeout: DECORATION_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);

    return {
      page,
      consoleErrors,
      decorated,
      close: () => closeAll(browser, server, cleanupFiles),
    };
  } catch (err) {
    await closeAll(browser, server, cleanupFiles);
    throw err;
  }
}

async function closeAll(browser: Browser, server: StaticServerHandle, cleanupFiles: () => Promise<void>): Promise<void> {
  await browser.close();
  await server.close();
  await cleanupFiles();
}
