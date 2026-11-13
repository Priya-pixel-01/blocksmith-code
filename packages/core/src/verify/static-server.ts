import { createServer, type Server } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { resolveInSandbox, SandboxViolationError } from "../tools/sandbox.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
};

export interface StaticServerHandle {
  port: number;
  baseUrl: string;
  close: () => Promise<void>;
}

/** Minimal static file server rooted at `root`, for rendering a block against the real files in an isolated job workspace. Not for any use beyond local verification — no caching, no directory listing, path-sandboxed. */
export async function startStaticServer(root: string): Promise<StaticServerHandle> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
        const relativePath = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
        const absPath = resolveInSandbox(root, relativePath);

        const info = await stat(absPath).catch(() => null);
        if (!info || !info.isFile()) {
          res.writeHead(404).end("Not found");
          return;
        }

        const content = await readFile(absPath);
        const mime = MIME_TYPES[extname(absPath)] ?? "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime }).end(content);
      } catch (err) {
        if (err instanceof SandboxViolationError) {
          res.writeHead(403).end("Forbidden");
          return;
        }
        res.writeHead(500).end("Internal error");
      }
    })();
  });

  const port = await new Promise<number>((resolvePort, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") resolvePort(address.port);
      else reject(new Error("Could not determine static server port"));
    });
  });

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}
