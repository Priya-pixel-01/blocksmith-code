import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as schema from "./schema.js";

export type DbClient = ReturnType<typeof drizzle<typeof schema>>;

let instance: DbClient | null = null;
let sqliteInstance: Database.Database | null = null;

/** Opens (and lazily migrates) the SQLite database at `path`. Idempotent â€” call anywhere, safe to call repeatedly. */
export function getDb(path: string): DbClient {
  if (instance) return instance;
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqliteInstance = sqlite;
  instance = drizzle(sqlite, { schema });
  ensureSchema(sqlite);
  return instance;
}

/**
 * Creates tables directly instead of via drizzle-kit generated migrations â€” appropriate for a
 * young project with no production data yet. Switch to drizzle-kit migrations once the schema
 * needs versioned, backward-compatible changes.
 */
function ensureSchema(sqlite: Database.Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      root_path TEXT NOT NULL,
      is_git_repo INTEGER NOT NULL,
      repo_profile_json TEXT,
      repo_profile_cache_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      source_artifact_json TEXT,
      block_spec_json TEXT,
      reuse_decision_json TEXT,
      plan_json TEXT,
      verdict_json TEXT,
      feedback TEXT,
      iteration INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      cost_usd_microcents INTEGER,
      workspace_dir TEXT,
      result_branch TEXT,
      write_result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_batch ON jobs(batch_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_workspace ON jobs(workspace_id);

    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT,
      agent TEXT,
      message TEXT NOT NULL,
      data_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id);

    CREATE TABLE IF NOT EXISTS figma_cache (
      url TEXT PRIMARY KEY,
      source_artifact_json TEXT NOT NULL,
      preview_image_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const columns = sqlite.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
  for (const column of ["open_questions_json", "question_answers_json", "implementation_mode"]) {
    if (!columns.some((entry) => entry.name === column)) sqlite.exec(`ALTER TABLE jobs ADD COLUMN ${column} TEXT`);
  }
}

/** Test-only escape hatch so each test file gets a clean singleton. */
export function __resetDbForTests() {
  sqliteInstance?.close();
  sqliteInstance = null;
  instance = null;
}
