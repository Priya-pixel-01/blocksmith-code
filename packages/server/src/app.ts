import express from "express";
import cors from "cors";
import { env } from "./env.js";
import { workspaceRouter } from "./routes/workspace.js";
import { uploadsRouter } from "./routes/uploads.js";
import { batchRouter } from "./routes/batch.js";
import { jobsRouter } from "./routes/jobs.js";
import { adminRouter } from "./routes/admin.js";
import { attachUser, requireAdmin, requireBlocksmithAccess } from "./routes/auth.js";
import { authRouter } from "./routes/authRouter.js";

/** Builds the Express app with no network side effects, so it's usable directly in tests. */
export function createApp(): express.Express {
  const app = express();
  app.use(cors({ origin: env.webOrigin, credentials: true }));
  app.use(express.json({ limit: "2mb" }));
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.use("/api", authRouter);
  app.use("/api", attachUser, requireBlocksmithAccess, workspaceRouter);
  app.use("/api", attachUser, requireBlocksmithAccess, uploadsRouter);
  app.use("/api", attachUser, requireBlocksmithAccess, batchRouter);
  app.use("/api", attachUser, requireBlocksmithAccess, jobsRouter);
  app.use("/api/admin", attachUser, requireAdmin, adminRouter);

  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(400).json({ error: err.message });
  });

  return app;
}
