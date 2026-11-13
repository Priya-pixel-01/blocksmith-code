import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, deleteJob, getJob, listJobs, subscribeToJobEvents } from "../api.js";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { formatCost } from "../format.js";
import type { Job, JobStatus } from "../types.js";

const TERMINAL = new Set(["done", "failed", "rejected", "code_only"]);

const STATUS_LABELS: Record<JobStatus, string> = {
  created: "created",
  ingesting: "ingesting",
  analyzing: "analyzing",
  awaiting_answers: "awaiting answers",
  planning: "planning",
  awaiting_approval: "awaiting approval",
  code_only: "code written",
  building: "building",
  verifying: "verifying",
  writing: "writing",
  deployed: "deployed",
  post_feedback_building: "refining",
  post_feedback_verifying: "verifying feedback",
  done: "done",
  failed: "failed",
  rejected: "rejected",
};

export function JobBoardPage() {
  const { batchId } = useParams<{ batchId: string }>();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!batchId) return;
    let cancelled = false;
    listJobs(batchId)
      .then((res) => !cancelled && setJobs(res.jobs))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [batchId]);

  // One SSE subscription per non-terminal job — on a status event, re-fetches the full job record
  // (not just the status) so a row's title, cost, and plan all stay live, not just its badge.
  useEffect(() => {
    const unsubscribes = jobs
      .filter((j) => !TERMINAL.has(j.status))
      .map((job) =>
        subscribeToJobEvents(job.id, (event) => {
          if (event.type !== "status") return;
          getJob(job.id).then((fresh) => {
            setJobs((prev) => prev.map((j) => (j.id === fresh.id ? fresh : j)));
          });
        }),
      );
    return () => unsubscribes.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs.map((j) => `${j.id}:${TERMINAL.has(j.status)}`).join(",")]);

  const summary = useMemo(() => {
    const byStatus: Partial<Record<JobStatus, number>> = {};
    let totalCost: number | null = null;
    for (const job of jobs) {
      byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
      if (job.costUsd != null) totalCost = (totalCost ?? 0) + job.costUsd;
    }
    return { byStatus, totalCost };
  }, [jobs]);

  function closeJobDialog() {
    if (actionPending) return;
    setSelectedJob(null);
    setActionError(null);
  }

  async function handleJobDelete() {
    if (!selectedJob) return;
    setActionPending(true);
    setActionError(null);
    try {
      await deleteJob(selectedJob.id);
      setJobs((current) => current.filter((job) => job.id !== selectedJob.id));
      setSelectedJob(null);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not delete this job.");
    } finally {
      setActionPending(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <div className="page-header__eyebrow">Batch {batchId}</div>
        <h1>Jobs</h1>
        <p className="page-header__subtitle">Each source is analyzed independently. Open a job once it's awaiting approval to review its plan.</p>
      </div>

      {loading && <div className="empty-state">Loading…</div>}

      {!loading && jobs.length === 0 && <div className="empty-state">No jobs in this batch.</div>}

      {!loading && jobs.length > 0 && (
        <div className="batch-summary">
          <div className="batch-summary__row">
            {(Object.entries(summary.byStatus) as Array<[JobStatus, number]>).map(([status, count]) => (
              <span className="tag" key={status}>
                {count} {STATUS_LABELS[status]}
              </span>
            ))}
            <span className="tag" title="Total LLM cost across every job in this batch">
              {formatCost(summary.totalCost)} total
            </span>
          </div>
        </div>
      )}

      <div className="card-list">
        {jobs.map((job) => (
          <div className="job-row" key={job.id}>
            <Link to={`/jobs/${job.id}`} className="plain-link job-row__main">
              <div className="job-row__title">
                {job.batchTitle ?? job.plan?.blockName ?? job.sourceRef.split('/').pop()}
              </div>
              <div className="job-row__meta">
                {job.sourceKind} · {job.sourceRef}
              </div>
            </Link>
            <div className="row">
              <span className="text-subtle" style={{ fontSize: "12px" }}>
                {formatCost(job.costUsd)}
              </span>
              <StatusBadge status={job.status} />
              <button
                type="button"
                className="batch-row__delete"
                title="Delete job"
                aria-label={`Delete job ${job.sourceRef}`}
                onClick={() => {
                  setSelectedJob(job);
                  setActionError(null);
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 7h16" />
                  <path d="M10 11v6" />
                  <path d="M14 11v6" />
                  <path d="M5 7l1 13h12l1-13" />
                  <path d="M9 7V4h6v3" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>
      {selectedJob && (
        <ConfirmDialog
          title={TERMINAL.has(selectedJob.status) ? "Delete job?" : "Terminate and delete job?"}
          message={TERMINAL.has(selectedJob.status)
            ? `Delete the job for ${selectedJob.sourceRef}? This will not delete the rest of the batch.`
            : `This job is still active. It will be terminated before ${selectedJob.sourceRef} is deleted.`}
          confirmLabel={TERMINAL.has(selectedJob.status) ? "Delete" : "Terminate & Delete"}
          pending={actionPending}
          error={actionError}
          onConfirm={handleJobDelete}
          onCancel={closeJobDialog}
        />
      )}
    </>
  );
}
