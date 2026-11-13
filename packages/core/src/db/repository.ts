import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { DbClient } from "./client.js";
import { jobs, jobEvents, workspaces, figmaCache } from "./schema.js";
import type { JobStatus, JobEvent, RepoProfile, SourceArtifact, OpenQuestion, OpenQuestionAnswer } from "../schemas/index.js";
import type { AemImplementationMode } from "../schemas/question.js";
import { batchTitleFromIntent } from "../batch-title.js";

export interface JobRecord {
  id: string;
  batchId: string;
  workspaceId: string;
  status: JobStatus;
  sourceKind: "figma" | "image" | "pdf";
  sourceRef: string;
  implementationMode: AemImplementationMode | null;
  sourceArtifact: unknown;
  blockSpec: unknown;
  reuseDecision: unknown;
  plan: unknown;
  verdict: unknown;
  feedback: string | null;
  openQuestions: OpenQuestion[];
  questionAnswers: OpenQuestionAnswer[];
  iteration: number;
  errorMessage: string | null;
  costUsd: number | null;
  workspaceDir: string | null;
  resultBranch: string | null;
  writeResult: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface BatchSummary {
  batchId: string;
  batchTitle: string;
  jobCount: number;
  createdAt: string;
  byStatus: Partial<Record<JobStatus, number>>;
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  return JSON.parse(value) as T;
}

const MICROCENTS_PER_USD = 1_000_000;

function toMicrocents(usd: number): number {
  return Math.round(usd * MICROCENTS_PER_USD);
}

function fromMicrocents(value: number | null): number | null {
  return value == null ? null : value / MICROCENTS_PER_USD;
}

function rowToJob(row: typeof jobs.$inferSelect): JobRecord {
  return {
    id: row.id,
    batchId: row.batchId,
    workspaceId: row.workspaceId,
    status: row.status as JobStatus,
    sourceKind: row.sourceKind as JobRecord["sourceKind"],
    sourceRef: row.sourceRef,
    implementationMode: row.implementationMode as AemImplementationMode | null,
    sourceArtifact: parseJson(row.sourceArtifactJson),
    blockSpec: parseJson(row.blockSpecJson),
    reuseDecision: parseJson(row.reuseDecisionJson),
    plan: parseJson(row.planJson),
    verdict: parseJson(row.verdictJson),
    feedback: row.feedback,
    openQuestions: parseJson<OpenQuestion[]>(row.openQuestionsJson) ?? [],
    questionAnswers: parseJson<OpenQuestionAnswer[]>(row.questionAnswersJson) ?? [],
    iteration: row.iteration,
    errorMessage: row.errorMessage,
    costUsd: fromMicrocents(row.costUsd),
    workspaceDir: row.workspaceDir,
    resultBranch: row.resultBranch,
    writeResult: parseJson(row.writeResultJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class JobRepository {
  constructor(private db: DbClient) {}

  createJob(input: {
    batchId: string;
    workspaceId: string;
    sourceKind: JobRecord["sourceKind"];
    sourceRef: string;
    implementationMode?: AemImplementationMode | null;
  }): JobRecord {
    const now = new Date().toISOString();
    const id = `job_${nanoid(12)}`;
    this.db
      .insert(jobs)
      .values({
        id,
        batchId: input.batchId,
        workspaceId: input.workspaceId,
        status: "created" satisfies JobStatus,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef,
        implementationMode: input.implementationMode ?? null,
        iteration: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return this.getJob(id)!;
  }

  getJob(id: string): JobRecord | null {
    const row = this.db.select().from(jobs).where(eq(jobs.id, id)).get();
    return row ? rowToJob(row) : null;
  }

  listByBatch(batchId: string): JobRecord[] {
    return this.db.select().from(jobs).where(eq(jobs.batchId, batchId)).all().map(rowToJob);
  }

  update(id: string, patch: Partial<Record<string, unknown>>): void {
    this.db
      .update(jobs)
      .set({ ...patch, updatedAt: new Date().toISOString() })
      .where(eq(jobs.id, id))
      .run();
  }

  setStatus(id: string, status: JobStatus, errorMessage?: string): void {
    this.update(id, { status, errorMessage: errorMessage ?? null });
  }

  /** Adds to a job's running cost total. A no-op when deltaUsd is null (the call it came from reported no usage data). */
  addCost(id: string, deltaUsd: number | null): void {
    if (deltaUsd == null) return;
    const current = this.getJob(id)?.costUsd ?? 0;
    this.update(id, { costUsd: toMicrocents(current + deltaUsd) });
  }

  /** Groups a workspace's jobs by batchId â€” there's no separate `batches` table, batchId is just a shared grouping key. */
  listBatchesByWorkspace(workspaceId: string): BatchSummary[] {
    const rows = this.db.select().from(jobs).where(eq(jobs.workspaceId, workspaceId)).all().map(rowToJob);

    const byBatch = new Map<string, JobRecord[]>();
    for (const job of rows) {
      const list = byBatch.get(job.batchId);
      if (list) list.push(job);
      else byBatch.set(job.batchId, [job]);
    }

    const summaries = [...byBatch.entries()].map(([batchId, jobsInBatch]): BatchSummary => {
      const byStatus: Partial<Record<JobStatus, number>> = {};
      for (const job of jobsInBatch) {
        byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
      }
      const createdAt = jobsInBatch.reduce((earliest, j) => (j.createdAt < earliest ? j.createdAt : earliest), jobsInBatch[0]!.createdAt);
      const firstTitleJob = jobsInBatch.find((job) => {
        const spec = job.blockSpec as { intent?: unknown; purpose?: unknown } | null;
          return [spec?.intent, spec?.purpose].some((value) => typeof value === "string" && value.trim().length > 0);
      });
      const firstDecision = (firstTitleJob?.plan as { reuseDecision?: { decision?: unknown } } | null)?.reuseDecision?.decision;
      return { batchId, batchTitle: batchTitleFromIntent(firstTitleJob?.blockSpec, firstDecision), jobCount: jobsInBatch.length, createdAt, byStatus };
    });

    return summaries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  deleteJob(id: string): void {
    this.db.delete(jobEvents).where(eq(jobEvents.jobId, id)).run();
    this.db.delete(jobs).where(eq(jobs.id, id)).run();
  }

  deleteBatch(batchId: string): void {
    const batchJobs = this.listByBatch(batchId);
    for (const job of batchJobs) this.deleteJob(job.id);
  }

  appendEvent(event: JobEvent): void {
    this.db
      .insert(jobEvents)
      .values({
        jobId: event.jobId,
        ts: event.ts,
        type: event.type,
        status: event.status,
        agent: event.agent,
        message: event.message,
        dataJson: event.data ? JSON.stringify(event.data) : null,
      })
      .run();
  }

  listEvents(jobId: string): JobEvent[] {
    return this.db
      .select()
      .from(jobEvents)
      .where(eq(jobEvents.jobId, jobId))
      .all()
      .map((row) => ({
        jobId: row.jobId,
        ts: row.ts,
        type: row.type as JobEvent["type"],
        status: row.status as JobEvent["status"],
        agent: row.agent,
        message: row.message,
        data: row.dataJson ? JSON.parse(row.dataJson) : null,
      }));
  }
}

export class WorkspaceRepository {
  constructor(private db: DbClient) {}

  upsert(input: { id: string; rootPath: string; isGitRepo: boolean }): void {
    const now = new Date().toISOString();
    const existing = this.db.select().from(workspaces).where(eq(workspaces.id, input.id)).get();
    if (existing) {
      this.db
        .update(workspaces)
        .set({ rootPath: input.rootPath, isGitRepo: input.isGitRepo, updatedAt: now })
        .where(eq(workspaces.id, input.id))
        .run();
      return;
    }
    this.db
      .insert(workspaces)
      .values({
        id: input.id,
        rootPath: input.rootPath,
        isGitRepo: input.isGitRepo,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  get(id: string): { id: string; rootPath: string; isGitRepo: boolean; repoProfile: RepoProfile | null; repoProfileCacheKey: string | null } | null {
    const row = this.db.select().from(workspaces).where(eq(workspaces.id, id)).get();
    if (!row) return null;
    return {
      id: row.id,
      rootPath: row.rootPath,
      isGitRepo: row.isGitRepo,
      repoProfile: parseJson<RepoProfile>(row.repoProfileJson),
      repoProfileCacheKey: row.repoProfileCacheKey,
    };
  }

  saveRepoProfile(id: string, profile: RepoProfile, cacheKey: string): void {
    this.db
      .update(workspaces)
      .set({
        repoProfileJson: JSON.stringify(profile),
        repoProfileCacheKey: cacheKey,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(workspaces.id, id))
      .run();
  }
}

export class FigmaCacheRepository {
  constructor(private db: DbClient) {}

  get(url: string): { artifact: SourceArtifact; previewImagePath: string | null; updatedAt: string } | null {
    const row = this.db.select().from(figmaCache).where(eq(figmaCache.url, url)).get();
    if (!row) return null;
    return {
      artifact: parseJson<SourceArtifact>(row.sourceArtifactJson)!,
      previewImagePath: row.previewImagePath,
      updatedAt: row.updatedAt,
    };
  }

  set(url: string, artifact: SourceArtifact, previewImagePath: string | null): void {
    const now = new Date().toISOString();
    const existing = this.db.select().from(figmaCache).where(eq(figmaCache.url, url)).get();
    if (existing) {
      this.db
        .update(figmaCache)
        .set({
          sourceArtifactJson: JSON.stringify(artifact),
          previewImagePath,
          updatedAt: now,
        })
        .where(eq(figmaCache.url, url))
        .run();
      return;
    }
    this.db
      .insert(figmaCache)
      .values({
        url,
        sourceArtifactJson: JSON.stringify(artifact),
        previewImagePath,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  delete(url: string): void {
    this.db.delete(figmaCache).where(eq(figmaCache.url, url)).run();
  }
}
