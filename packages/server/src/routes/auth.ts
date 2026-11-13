import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import { env } from "../env.js";
import { getPool, toolsTable, userToolsTable, usersTable } from "./admin.js";

const COOKIE_NAME = "blocksmith_session";
const SESSION_TTL_SECONDS = 60 * 60 * 8;

export interface AuthUser {
  id: string;
  email: string;
  isAdmin: boolean;
  tools: string[];
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

interface JwtPayload {
  sub: string;
  iat: number;
  exp: number;
}

function sign(value: string): string {
  return createHmac("sha256", env.authSessionSecret)
    .update(value)
    .digest("base64url");
}

function createSessionToken(userId: string): string {
  const now = Math.floor(Date.now() / 1000);

  const header = Buffer.from(
    JSON.stringify({
      alg: "HS256",
      typ: "JWT",
    }),
  ).toString("base64url");

  const payload: JwtPayload = {
    sub: userId,
    iat: now,
    exp: now + SESSION_TTL_SECONDS,
  };

  const encodedPayload = Buffer.from(
    JSON.stringify(payload),
  ).toString("base64url");

  const content = `${header}.${encodedPayload}`;
  const signature = sign(content);

  return `${content}.${signature}`;
}

function verifySessionToken(token?: string): JwtPayload | null {
  if (!token) return null;

  const parts = token.split(".");

  if (parts.length !== 3) return null;

  const [header, payload, signature] = parts;

  if (!header || !payload || !signature) {
    return null;
  }

  try {
    // Validate the JWT header.
    const parsedHeader = JSON.parse(
      Buffer.from(header, "base64url").toString("utf8"),
    ) as {
      alg?: string;
      typ?: string;
    };

    if (
      parsedHeader.alg !== "HS256" ||
      parsedHeader.typ !== "JWT"
    ) {
      return null;
    }

    // Verify signature.
    const expected = sign(`${header}.${payload}`);

    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);

    if (actualBuffer.length !== expectedBuffer.length) {
      return null;
    }

    if (!timingSafeEqual(actualBuffer, expectedBuffer)) {
      return null;
    }

    // Decode payload.
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Partial<JwtPayload>;

    if (
      typeof parsed.sub !== "string" ||
      typeof parsed.iat !== "number" ||
      typeof parsed.exp !== "number"
    ) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);

    if (parsed.exp <= now) {
      return null;
    }

    return {
      sub: parsed.sub,
      iat: parsed.iat,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}

function readCookie(req: Request): string | undefined {
  return req.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);
}

async function findUser(id: string): Promise<AuthUser | null> {
  const result = await getPool().query<{
    id: string;
    email: string;
    isAdmin: boolean;
    tool_ids: string[];
  }>(
    `
    SELECT
      u.id,
      u.email,
      u.is_admin AS "isAdmin",
      COALESCE(
        array_agg(DISTINCT t.id)
        FILTER (WHERE t.id IS NOT NULL),
        '{}'
      ) AS tool_ids
    FROM ${usersTable()} u
    LEFT JOIN ${userToolsTable()} ut ON ut.user_id = u.id
    LEFT JOIN ${toolsTable()} t ON t.id = ut.tool_id
    WHERE u.id = $1
    GROUP BY u.id, u.email, u.is_admin
    `,
    [id],
  );

  const row = result.rows[0];

  if (!row) return null;

  return {
    id: row.id,
    email: row.email,
    isAdmin: row.isAdmin,
    tools: row.tool_ids || [],
  };
}

export async function authenticate(
  email: string,
  password: string,
): Promise<AuthUser | null> {
  const result = await getPool().query<{
    id: string;
    passwordHash: string;
  }>(
    `
    SELECT
      id,
      password_hash AS "passwordHash"
    FROM ${usersTable()}
    WHERE lower(email) = lower($1)
    `,
    [email],
  );

  const row = result.rows[0];

  if (!row) {
    return null;
  }

  if (row.passwordHash.startsWith("scrypt$")) {
    return null;
  }

  const passwordMatches = await bcrypt.compare(
    password,
    row.passwordHash,
  );

  if (!passwordMatches) {
    return null;
  }

  return findUser(row.id);
}

export async function attachUser(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    const token = readCookie(req);
    const payload = verifySessionToken(token);

    if (!payload) {
      return next();
    }

    // Important:
    // We load the current user from the database.
    // Therefore admin/tool changes take effect immediately.
    const user = await findUser(payload.sub);

    if (user) {
      req.user = user;
    }

    next();
  } catch (error) {
    next(error);
  }
}

export function requireAuthenticated(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!req.user) {
    return res.status(401).json({
      error: "Sign in is required.",
    });
  }

  next();
}

export function requireBlocksmithAccess(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!req.user) {
    return res.status(401).json({
      error: "Sign in is required.",
    });
  }

  if (
    !req.user.isAdmin &&
    !req.user.tools.includes(env.blocksmithToolSlug)
  ) {
    return res.status(403).json({
      error: "Your account does not have access to Blocksmith.",
    });
  }

  next();
}

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  if (!req.user) {
    return res.status(401).json({
      error: "Sign in is required.",
    });
  }

  if (!req.user.isAdmin) {
    return res.status(403).json({
      error: "Administrator access is required.",
    });
  }

  next();
}

export function setUserSession(
  res: Response,
  user: AuthUser,
) {
  const token = createSessionToken(user.id);

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProduction,
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: "/",
  });
}

export function clearSession(res: Response) {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.isProduction,
    path: "/",
  });
}