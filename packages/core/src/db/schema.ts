import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * One row per workspace (a target EDS repo folder Blocksmith has been pointed at).
 * repoProfileJson is the cached Cartographer output; recomputed when cacheKey changes.
 */
export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  rootPath: text("root_path").notNull(),
  isGitRepo: integer("is_git_repo", { mode: "boolean" }).notNull(),
  repoProfileJson: text("repo_profile_json"),
  repoProfileCacheKey: text("repo_profile_cache_key"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/**
 * One row per conversion job (one source -> one candidate block).
 * Jobs in the same batch share a workspaceId and a batchId, and run concurrently.
 */
export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  batchId: text("batch_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  status: text("status").notNull(), // JobStatus
  sourceKind: text("source_kind").notNull(), // 'figma' | 'image' | 'pdf'
  sourceRef: text("source_ref").notNull(), // URL or original filename
  implementationMode: text("implementation_mode"), // 'properties' | 'sling_model' for AEM jobs
  sourceArtifactJson: text("source_artifact_json"),
  blockSpecJson: text("block_spec_json"),
  reuseDecisionJson: text("reuse_decision_json"),
  planJson: text("plan_json"),
  verdictJson: text("verdict_json"),
  feedback: text("feedback"), // human reject-with-feedback, accumulated across rounds; re-fed to Interpreter/Reuse/Planner
  openQuestionsJson: text("open_questions_json"),
  questionAnswersJson: text("question_answers_json"),
  iteration: integer("iteration").notNull().default(0),
  errorMessage: text("error_message"),
  costUsd: integer("cost_usd_microcents"), // stored as integer micro-cents to avoid float drift
  workspaceDir: text("workspace_dir"), // isolated job workspace on disk
  resultBranch: text("result_branch"),
  writeResultJson: text("write_result_json"), // WriteResult from the Writer: mode, branchName, commitSha, filesWritten, backupDir
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

/** Append-only agent activity log â€” every tool call, tool result, and status transition. Drives SSE + replay. */
export const jobEvents = sqliteTable("job_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: text("job_id").notNull(),
  ts: text("ts").notNull(),
  type: text("type").notNull(), // 'status' | 'agent-message' | 'tool-call' | 'tool-result' | 'error'
  status: text("status"),
  agent: text("agent"),
  message: text("message").notNull(),
  dataJson: text("data_json"),
});

/**
 * Cached Figma source artifacts to avoid redundant API calls.
 * Key is the Figma URL; cached data includes the rendered image and pruned node tree.
 */
export const figmaCache = sqliteTable("figma_cache", {
  url: text("url").primaryKey(), // Normalized Figma URL (fileKey + nodeId)
  sourceArtifactJson: text("source_artifact_json").notNull(),
  previewImagePath: text("preview_image_path"), // Path to cached preview image
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
