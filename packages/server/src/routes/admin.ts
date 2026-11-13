import { Router } from "express";
import bcrypt from "bcryptjs";
import pg from "pg";
import { z } from "zod";
import { env } from "../env.js";

const { Pool } = pg;

const adminRouter = Router();
let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (pool) return pool;

  const {
    host,
    port,
    database,
    user,
    password,
    ssl,
    rejectUnauthorized,
  } = env.adminDatabase;
  if (!host || !database || !user || !password) {
    throw new Error("Admin database configuration is incomplete");
  }

  pool = new Pool({
    host,
    port,
    database,
    user,
    password,
    ssl: ssl ? { rejectUnauthorized } : false,
  });
  // pool.query("SELECT 1")
  // .then(() => console.log("✅ Database connected"))
  // .catch(err => console.error("❌ Database error:", err.message));

  return pool;
  
}


function quoteIdentifier(identifier: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error("ADMIN_USERS_TABLE must be a valid SQL identifier");
  }
  return `"${identifier}"`;
}

function formatDate(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function formatTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export const usersTable = () => quoteIdentifier(process.env.ADMIN_USERS_TABLE ?? "users");
export const toolsTable = () => quoteIdentifier(process.env.ADMIN_TOOLS_TABLE ?? "tools");
export const userToolsTable = () => quoteIdentifier(process.env.ADMIN_USER_TOOLS_TABLE ?? "user_tools");
export const auditLogsTable = () => quoteIdentifier(process.env.ADMIN_AUDIT_LOGS_TABLE ?? "audit_logs");
export const projectsTable = () => quoteIdentifier(process.env.ADMIN_PROJECTS_TABLE ?? "projects");
export const projectMembersTable = () => quoteIdentifier(process.env.ADMIN_PROJECT_MEMBERS_TABLE ?? "project_members");
export const projectApiKeysTable = () => quoteIdentifier(process.env.ADMIN_PROJECT_API_KEYS_TABLE ?? "project_api_keys");

export async function withTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const uuidSchema = z.string().uuid();
const memberPayloadSchema = z.object({
  userId: uuidSchema,
  role: z.string().trim().min(1).max(50),
});
const apiKeyPayloadSchema = z.object({
  apiKey: z.string().trim().min(1).max(500),
});
const createToolPayloadSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(10000),
  url: z.string().trim().url().max(500),
});
const updateToolPayloadSchema = createToolPayloadSchema.pick({ description: true, url: true });

function currentAdminId(req: import("express").Request): string {
  return uuidSchema.parse(req.user?.id);
}

async function writeAuditLog(
  client: pg.PoolClient,
  req: import("express").Request,
  action: string,
  resourceType: string,
  resourceId: string,
  details: Record<string, unknown> | null = null,
): Promise<void> {
  await client.query(
    `INSERT INTO ${auditLogsTable()} (admin_id, action, resource_type, resource_id, details, ip_address)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::inet)`,
    [
      currentAdminId(req),
      action,
      resourceType,
      resourceId,
      details === null ? null : JSON.stringify(details),
      req.ip || null,
    ],
  );
}

// Admin Console: Users tab - list users.
adminRouter.get("/users", async (_req, res, next) => {
  try {
    const pool = getPool();
    const result = await pool.query<{
      id: string;
      email: string;
      is_admin: boolean;
      created_at: string | Date;
      updated_at: string | Date;
    }>(
      `SELECT id, email, is_admin, created_at, updated_at FROM ${usersTable()} ORDER BY created_at DESC`,
    );

    res.json(
      result.rows.map((user) => ({
        id: String(user.id),
        email: user.email,
        admin: Boolean(user.is_admin),
        created: formatDate(user.created_at),
        updated_at: formatDate(user.updated_at),
      })),
    );
  } catch (error) {
    next(error);
  }
});

// Admin Console: Tools tab and Users tab - list tools.
adminRouter.get("/tools", async (_req, res, next) => {
  try {
    const result = await getPool().query<{
      id: string;
      name: string;
      description: string | null;
      created_at: string | Date;
      url: string;
    }>(
      `SELECT id, name, description, created_at, url FROM ${toolsTable()} ORDER BY name ASC`,
    );
    res.json(result.rows.map((tool) => ({
      ...tool,
      id: String(tool.id),
      created_at: formatTimestamp(tool.created_at),
    })));
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/tools", async (req, res, next) => {
  const client = await getPool().connect();
  try {
    const { name, description, url } = createToolPayloadSchema.parse(req.body);
    await client.query("BEGIN");
    const result = await client.query<{
      id: string;
      name: string;
      description: string | null;
      created_at: string | Date;
      url: string;
    }>(
      `INSERT INTO ${toolsTable()} (name, description, url)
       VALUES ($1, $2, $3)
       RETURNING id, name, description, created_at, url`,
      [name, description, url],
    );
    const tool = result.rows[0];
    if (!tool) throw new Error("Tool could not be created");
    await writeAuditLog(client, req, "CREATE_TOOL", "tool", tool.id, { toolName: tool.name, description, url });
    await client.query("COMMIT");
    res.status(201).json({ ...tool, id: String(tool.id), created_at: formatTimestamp(tool.created_at) });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

adminRouter.put("/tools/:id", async (req, res, next) => {
  const client = await getPool().connect();
  try {
    const id = uuidSchema.parse(req.params.id);
    const { description, url } = updateToolPayloadSchema.parse(req.body);
    await client.query("BEGIN");
    const result = await client.query<{
      id: string;
      name: string;
      description: string | null;
      created_at: string | Date;
      url: string;
    }>(
      `UPDATE ${toolsTable()} SET description = $2, url = $3 WHERE id = $1
      RETURNING id, name, description, created_at, url`,
      [id, description, url],
    );
    const tool = result.rows[0];
    if (!tool) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Tool not found" });
      return;
    }
    await writeAuditLog(client, req, "UPDATE_TOOL", "tool", tool.id, { toolName: tool.name, description, url });
    await client.query("COMMIT");
    res.json({ ...tool, id: String(tool.id), created_at: formatTimestamp(tool.created_at) });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

adminRouter.delete("/tools/:id", async (req, res, next) => {
  const client = await getPool().connect();
  try {
    const id = uuidSchema.parse(req.params.id);
    await client.query("BEGIN");
    const toolResult = await client.query<{ name: string }>(`SELECT name FROM ${toolsTable()} WHERE id = $1`, [id]);
    const tool = toolResult.rows[0];
    if (!tool) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Tool not found" });
      return;
    }
    await client.query(`DELETE FROM ${userToolsTable()} WHERE tool_id = $1`, [id]);
    const result = await client.query(`DELETE FROM ${toolsTable()} WHERE id = $1`, [id]);
    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Tool not found" });
      return;
    }
    await writeAuditLog(client, req, "DELETE_TOOL", "tool", id, { toolName: tool.name });
    await client.query("COMMIT");
    res.status(204).send();
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

// Admin Console: Users tab - create a user and assign selected tools atomically.
adminRouter.post("/users", async (req, res, next) => {
  const { email, password, isAdmin, toolIds } = req.body as {
    email?: unknown;
    password?: unknown;
    isAdmin?: unknown;
    toolIds?: unknown;
  };

  if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }
  if (!Array.isArray(toolIds) || !toolIds.every((id) => typeof id === "string")) {
    res.status(400).json({ error: "toolIds must be an array of tool IDs" });
    return;
  }

  const selectedToolIds = [...new Set(toolIds as string[])];
  const passwordHash = await hashPassword(password);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const userResult = await client.query<{
      id: string;
      email: string;
      is_admin: boolean;
      created_at: string | Date;
      updated_at: string | Date;
    }>(
      `INSERT INTO ${usersTable()} (email, password_hash, is_admin) VALUES ($1, $2, $3) RETURNING id, email, is_admin, created_at, updated_at`,
      [email.trim(), passwordHash, isAdmin === true],
    );
    const user = userResult.rows[0];
    if (!user) {
      throw new Error("User could not be created");
    }

    if (selectedToolIds.length > 0) {
      const toolResult = await client.query<{ id: string }>(
        `SELECT id FROM ${toolsTable()} WHERE id = ANY($1::uuid[])`,
        [selectedToolIds],
      );
      if (toolResult.rowCount !== selectedToolIds.length) {
        throw new Error("One or more selected tools do not exist");
      }
      await client.query(
        `INSERT INTO ${userToolsTable()} (user_id, tool_id) SELECT $1, tool_id FROM unnest($2::uuid[]) AS tool_id`,
        [user.id, selectedToolIds],
      );
    }

    await writeAuditLog(client, req, "CREATE_USER", "user", user.id, {
      email: user.email,
      isAdmin: user.is_admin,
      toolIds: selectedToolIds,
    });
    await client.query("COMMIT");
    res.status(201).json({
      id: String(user.id),
      email: user.email,
      admin: Boolean(user.is_admin),
      created: formatDate(user.created_at),
      updated_at: formatDate(user.updated_at),
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

// Admin Console: Users tab - remove assignments before deleting the user.
adminRouter.delete("/users/:id", async (req, res, next) => {
  const client = await getPool().connect();
  try {
    const userId = uuidSchema.parse(req.params.id);
    const adminId = currentAdminId(req);
    if (userId === adminId) {
      res.status(400).json({ error: "Administrators cannot delete their own account" });
      return;
    }
    await client.query("BEGIN");

    // Get the user's details and assigned tools BEFORE deleting them.
    const userResult = await client.query<{email: string;}>(`SELECT email FROM ${usersTable()} WHERE id = $1`,[userId],);
    const user = userResult.rows[0];
    if (!user) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "User not found" });
      return;
    }
    const toolResult = await client.query<{ tool_id: string }>(
      `SELECT tool_id FROM ${userToolsTable()} WHERE user_id = $1`,
      [userId],
    );
    const toolIds = toolResult.rows.map((row) => String(row.tool_id));

    // First delete every user_tools row belonging to this user.
    await client.query(`DELETE FROM ${userToolsTable()} WHERE user_id = $1`, [userId]);

    // Only after the assignments are removed, delete the users row itself.
    const result = await client.query(`DELETE FROM ${usersTable()} WHERE id = $1`, [userId]);
    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "User not found" });
      return;
    }

    await writeAuditLog(client, req, "DELETE_USER", "user", userId, {email: user.email, toolIds});
    await client.query("COMMIT");
    res.status(204).send();
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

adminRouter.get("/projects", async (req, res, next) => {
  try {
    const toolId = uuidSchema.parse(req.query.toolId);
    const result = await getPool().query<{
      id: string;
      name: string;
      tool_id: string;
      created_by_admin_id: string;
      created_at: string | Date;
      updated_at: string | Date;
    }>(
      `SELECT id, name, tool_id, created_by_admin_id, created_at, updated_at
         FROM ${projectsTable()}
        WHERE tool_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC`,
      [toolId],
    );

    res.json(result.rows.map((project) => ({
      id: String(project.id),
      name: project.name,
      tool_id: String(project.tool_id),
      created: formatDate(project.created_at),
      created_by_admin_id: String(project.created_by_admin_id),
      updated_at: formatDate(project.updated_at),
    })));
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/projects", async (req, res, next) => {
  const client = await getPool().connect();
  try {
    const name = z.string().trim().min(1).max(255).parse(req.body?.name);
    const toolId = uuidSchema.parse(req.body?.toolId);
    await client.query("BEGIN");
    const tool = await client.query<{ id: string }>(
      `SELECT id FROM ${toolsTable()} WHERE id = $1`,
      [toolId],
    );
    if (!tool.rows[0]) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Tool not found" });
      return;
    }
    const result = await client.query<{
      id: string;
      name: string;
      tool_id: string;
      created_by_admin_id: string;
      created_at: string | Date;
      updated_at: string | Date;
    }>(
      `INSERT INTO ${projectsTable()} (name, created_by_admin_id, tool_id)
       VALUES ($1, $2, $3)
       RETURNING id, name, tool_id, created_by_admin_id, created_at, updated_at`,
      [name, currentAdminId(req), toolId],
    );
    const project = result.rows[0];
    if (!project) throw new Error("Project could not be created");

    await writeAuditLog(client, req, "CREATE_PROJECT", "project", project.id, { projectName: project.name, toolId });
    await client.query("COMMIT");

    res.status(201).json({
      id: String(project.id),
      name: project.name,
      tool_id: String(project.tool_id),
      created: formatDate(project.created_at),
      created_by_admin_id: String(project.created_by_admin_id),
      updated_at: formatDate(project.updated_at),
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

adminRouter.delete("/projects/:id", async (req, res, next) => {
  const client = await getPool().connect();
  try {
    const projectId = uuidSchema.parse(req.params.id);
    await client.query("BEGIN");
    const projectResult = await client.query<{ name: string; tool_id: string }>(`SELECT name, tool_id FROM ${projectsTable()} WHERE id = $1`, [projectId]);
    const project = projectResult.rows[0];
    if (!project) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await client.query(`DELETE FROM ${projectMembersTable()} WHERE project_id = $1`, [projectId]);
    const result = await client.query(`DELETE FROM ${projectsTable()} WHERE id = $1`, [projectId]);
    if (result.rowCount === 0) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await writeAuditLog(client, req, "DELETE_PROJECT", "project", projectId, { projectName: project.name, toolId: project.tool_id });
    await client.query("COMMIT");
    res.status(204).send();
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

adminRouter.get("/projects/:id/members", async (req, res, next) => {
  try {
    const projectId = uuidSchema.parse(req.params.id);
    const result = await getPool().query<{
      id: string;
      user_id: string;
      email: string;
      role: string;
      assigned_at: string | Date;
    }>(
      `SELECT pm.id, pm.user_id, u.email, pm.role, pm.assigned_at FROM ${projectMembersTable()} pm JOIN ${usersTable()} u ON u.id = pm.user_id WHERE pm.project_id = $1 ORDER BY pm.assigned_at DESC`,
      [projectId],
    );
    res.json(result.rows.map((member) => ({
      id: String(member.id),
      user_id: String(member.user_id),
      user: member.email,
      role: member.role,
      added: formatDate(member.assigned_at),
    })));
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/projects/:id/available-users", async (req, res, next) => {
  try {
    const projectId = uuidSchema.parse(req.params.id);
    const result = await getPool().query<{ id: string; email: string }>(
      `SELECT u.id, u.email FROM ${usersTable()} u WHERE NOT EXISTS (SELECT 1 FROM ${projectMembersTable()} pm WHERE pm.project_id = $1 AND pm.user_id = u.id) ORDER BY u.email ASC`,
      [projectId],
    );
    res.json(result.rows.map((user) => ({ id: String(user.id), email: user.email })));
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/projects/:id/members", async (req, res, next) => {
  const client = await getPool().connect();
  try {
    const projectId = uuidSchema.parse(req.params.id);
    const { userId, role } = memberPayloadSchema.parse(req.body);
    await client.query("BEGIN");
    const result = await client.query<{
      id: string;
      user_id: string;
      role: string;
      assigned_at: string | Date;
    }>(
      `INSERT INTO ${projectMembersTable()} (project_id, user_id, role) SELECT $1, u.id, $3 FROM ${usersTable()} u WHERE u.id = $2 AND NOT EXISTS (SELECT 1 FROM ${projectMembersTable()} existing WHERE existing.project_id = $1 AND existing.user_id = $2) RETURNING id, user_id, role, assigned_at`,
      [projectId, userId, role],
    );
    const member = result.rows[0];
    if (!member) {
      await client.query("ROLLBACK");
      res.status(409).json({ error: "User is already a member or does not exist" });
      return;
    }
    const user = await client.query<{ email: string }>(`SELECT email FROM ${usersTable()} WHERE id = $1`, [member.user_id]);
    const project = await client.query<{ name: string; tool_id: string }>(`SELECT name, tool_id FROM ${projectsTable()} WHERE id = $1`, [projectId]);
    await writeAuditLog(client, req, "ADD_PROJECT_MEMBER", "project", projectId, {
      projectName: project.rows[0]?.name ?? "",
      toolId: project.rows[0]?.tool_id,
      userId: member.user_id,
      userEmail: user.rows[0]?.email ?? "",
      role: member.role,
    });
    await client.query("COMMIT");
    res.status(201).json({
      id: String(member.id),
      user_id: String(member.user_id),
      user: user.rows[0]?.email ?? "",
      role: member.role,
      added: formatDate(member.assigned_at),
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

adminRouter.delete("/projects/:projectId/members/:userId", async (req, res, next) => {
  const client = await getPool().connect();
  try {
    const projectId = uuidSchema.parse(req.params.projectId);
    const userId = uuidSchema.parse(req.params.userId);
    await client.query("BEGIN");
    const context = await client.query<{ project_name: string; user_email: string; tool_id: string }>(
      `SELECT p.name AS project_name, u.email AS user_email, p.tool_id
         FROM ${projectsTable()} p
         JOIN ${projectMembersTable()} pm ON pm.project_id = p.id
         JOIN ${usersTable()} u ON u.id = pm.user_id
        WHERE pm.project_id = $1 AND pm.user_id = $2`,
      [projectId, userId],
    );
    const memberContext = context.rows[0];
    if (!memberContext) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Project member not found" });
      return;
    }
    const result = await client.query(
      `DELETE FROM ${projectMembersTable()} WHERE project_id = $1 AND user_id = $2`,
      [projectId, userId],
    );
    if (result.rowCount === 0) {
      throw new Error("Project member could not be removed");
    }
    await writeAuditLog(client, req, "REMOVE_PROJECT_MEMBER", "project", projectId, {
      projectName: memberContext.project_name,
      toolId: memberContext.tool_id,
      userId,
      userEmail: memberContext.user_email,
    });
    await client.query("COMMIT");
    res.status(204).send();
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

// Admin Console: API Keys tab - return status only; the secret is never exposed to the client.
adminRouter.get("/api-keys/:projectId", async (req, res, next) => {
  try {
    const projectId = uuidSchema.parse(req.params.projectId);
    const result = await getPool().query<{
      id: string | null;
      project_id: string;
      project_name: string;
      openrouter_api_key: string | null;
      last_updated_at: string | Date | null;
      is_active: boolean | null;
    }>(
      `SELECT p.id AS project_id, p.name AS project_name,
              pak.id, pak.openrouter_api_key, pak.last_updated_at, pak.is_active
         FROM ${projectsTable()} AS p
         LEFT JOIN ${projectApiKeysTable()} AS pak ON pak.project_id = p.id
        WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [projectId],
    );
    const row = result.rows[0];
    if (!row) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    res.json({
      id: row.id ?? undefined,
      projectId: row.project_id,
      projectName: row.project_name,
      isConfigured: Boolean(row.openrouter_api_key?.trim()),
      lastUpdated: row.last_updated_at instanceof Date
        ? row.last_updated_at.toISOString()
        : row.last_updated_at ?? undefined,
      isActive: row.is_active ?? false,
    });
  } catch (error) {
    next(error);
  }
});

// Admin Console: API Keys tab - create or replace the key for a project.
adminRouter.put("/api-keys/:projectId", async (req, res, next) => {
  const client = await getPool().connect();
  try {
    const projectId = uuidSchema.parse(req.params.projectId);
    const { apiKey } = apiKeyPayloadSchema.parse(req.body);
    await client.query("BEGIN");
    const project = await client.query<{ id: string; name: string; tool_id: string }>(
      `SELECT id, name, tool_id FROM ${projectsTable()} WHERE id = $1 AND deleted_at IS NULL`,
      [projectId],
    );
    if (!project.rows[0]) {
      await client.query("ROLLBACK");
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const result = await client.query<{
      id: string;
      last_updated_at: string | Date;
      is_active: boolean;
    }>(
      `INSERT INTO ${projectApiKeysTable()} (project_id, openrouter_api_key, last_updated_at, is_active)
       VALUES ($1, $2, CURRENT_TIMESTAMP, true)
       ON CONFLICT (project_id) DO UPDATE
         SET openrouter_api_key = EXCLUDED.openrouter_api_key,
             last_updated_at = CURRENT_TIMESTAMP,
             is_active = true
       RETURNING id, last_updated_at, is_active`,
      [projectId, apiKey],
    );
    const row = result.rows[0];
    if (!row) throw new Error("API key could not be saved");

    await writeAuditLog(client, req, "UPDATE_API_KEY", "api_key", row.id, {
      projectId,
      projectName: project.rows[0].name,
      toolId: project.rows[0].tool_id,
    });
    await client.query("COMMIT");

    res.json({
      id: row.id,
      projectId,
      projectName: project.rows[0].name,
      isConfigured: true,
      lastUpdated: row.last_updated_at instanceof Date ? row.last_updated_at.toISOString() : row.last_updated_at,
      isActive: row.is_active,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    next(error);
  } finally {
    client.release();
  }
});

// Admin Console: Audit Logs tab - list audit events with the administrator's email.
adminRouter.get("/audit-logs", async (_req, res, next) => {
  try {
    const result = await getPool().query<{
      id: string;
      admin_id: string;
      admin_email: string | null;
      action: string;
      resource_type: string;
      resource_id: string;
      timestamp: string | Date;
      details: Record<string, unknown> | null;
      ip_address: string | null;
    }>(
      `SELECT audit.id, audit.admin_id, users.email AS admin_email, audit.action,
              audit.resource_type, audit.resource_id, audit.timestamp,
              audit.details, audit.ip_address
         FROM ${auditLogsTable()} AS audit
         LEFT JOIN ${usersTable()} AS users ON users.id = audit.admin_id
        ORDER BY audit.timestamp DESC`,
    );

    res.json(
      result.rows.map((log) => ({
        id: String(log.id),
        adminId: String(log.admin_id),
        adminEmail: log.admin_email ?? undefined,
        action: log.action,
        resourceType: log.resource_type,
        resourceId: String(log.resource_id),
        timestamp: log.timestamp instanceof Date ? log.timestamp.toISOString() : log.timestamp,
        details: log.details,
        ipAddress: log.ip_address,
      })),
    );
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/health", async (_req, res, next) => {
  try {
    await getPool().query("SELECT 1");
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

export { adminRouter };
