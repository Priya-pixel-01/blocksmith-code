import { Router } from "express";
import { z } from "zod";

import {
  authenticate,
  attachUser,
  clearSession,
  requireAuthenticated,
  setUserSession,
} from "./auth.js";
import { getPool, toolsTable, userToolsTable } from "./admin.js";

export const authRouter = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(256),
});

authRouter.post("/auth/login", async (req, res, next) => {
  try {
    const input = loginSchema.parse(req.body);

    const user = await authenticate(
      input.email,
      input.password,
    );

    if (!user) {
      return res.status(401).json({
        error: "Invalid email or password.",
      });
    }

    setUserSession(res, user);

    return res.json({ user });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/auth/logout", (req, res) => {
  clearSession(res);

  return res.json({
    ok: true,
  });
});

authRouter.get(
  "/auth/me",
  attachUser,
  requireAuthenticated,
  (req, res) => {
    return res.json({
      user: req.user,
    });
  },
);

authRouter.get("/tools", attachUser, requireAuthenticated, async (req, res, next) => {
  try {
    const result = await getPool().query<{
      id: string;
      name: string;
      description: string | null;
      url: string;
    }>(
      `
      SELECT t.id, t.name, t.description, t.url
      FROM ${userToolsTable()} ut
      JOIN ${toolsTable()} t ON t.id = ut.tool_id
      WHERE ut.user_id = $1
      ORDER BY t.name;
      `,
      [req.user!.id],
    );

    res.json(result.rows.map((tool) => ({ ...tool, id: String(tool.id) })));
  } catch (error) {
    next(error);
  }
});
