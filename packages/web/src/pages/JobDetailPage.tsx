import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ConfirmDialog } from "../components/ConfirmDialog.js";
import { getJob, approveJob, approveJobCodeOnly, rejectJob, submitAnswers, submitPostFeedback, retryJob, deleteJob, subscribeToJobEvents, ApiError } from "../api.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { MarkdownLite } from "../components/MarkdownLite.js";
import { formatCost } from "../format.js";
import type { Job, JobEvent } from "../types.js";

export function JobDetailPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const navigate = useNavigate();
  const [job, setJob] = useState<Job | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [feedback, setFeedback] = useState("");
  const [answerValues, setAnswerValues] = useState<Record<string, string>>({});
  const [answerFeedback, setAnswerFeedback] = useState("");
  const [showFeedbackBox, setShowFeedbackBox] = useState(false);
  const [postFeedback, setPostFeedback] = useState("");
  const [showPostFeedbackBox, setShowPostFeedbackBox] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!jobId) return;
    getJob(jobId).then(setJob);
  }, [jobId]);

  useEffect(() => {
    if (!jobId) return;
    setEvents([]);
    const unsubscribe = subscribeToJobEvents(jobId, (event) => {
      setEvents((prev) => [...prev, event]);
      if (event.type === "status") {
        getJob(jobId).then(setJob);
      }
    });
    return unsubscribe;
  }, [jobId]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [events.length]);

  if (!job) return <div className="empty-state">Loading…</div>;

  async function handleApprove() {
    if (!jobId) return;
    setActionPending(true);
    setActionError(null);
    try {
      await approveJob(jobId);
      setJob(await getJob(jobId));
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not approve this plan.");
    } finally {
      setActionPending(false);
    }
  }

  async function handleApproveCodeOnly() {
    if (!jobId) return;
    setActionPending(true);
    setActionError(null);
    try {
      await approveJobCodeOnly(jobId);
      setJob(await getJob(jobId));
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not approve this plan.");
    } finally {
      setActionPending(false);
    }
  }

  async function handleReject() {
    if (!jobId || !feedback.trim()) return;
    setActionPending(true);
    setActionError(null);
    try {
      await rejectJob(jobId, feedback.trim());
      setFeedback("");
      setShowFeedbackBox(false);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not submit feedback.");
    } finally {
      setActionPending(false);
    }
  }

  async function handleSubmitAnswers() {
    if (!jobId || !job) return;
    const answers = job.openQuestions.map((question) => ({ questionId: question.id, value: answerValues[question.id]?.trim() ?? "" }));
    if (answers.some((answer, index) => job.openQuestions[index]?.required && !answer.value)) {
      setActionError("Answer each required question before continuing.");
      return;
    }
    setActionPending(true);
    setActionError(null);
    try {
      await submitAnswers(jobId, answers.filter((answer) => answer.value), answerFeedback.trim());
      setAnswerFeedback("");
      setJob(await getJob(jobId));
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not submit answers.");
    } finally {
      setActionPending(false);
    }
  }

  async function handleSubmitPostFeedback() {
    if (!jobId || !postFeedback.trim()) return;
    setActionPending(true);
    setActionError(null);
    try {
      await submitPostFeedback(jobId, postFeedback.trim());
      setPostFeedback("");
      setShowPostFeedbackBox(false);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not submit post-deployment feedback.");
    } finally {
      setActionPending(false);
    }
  }

  async function handleRetry() {
    if (!jobId) return;
    setActionPending(true);
    setActionError(null);
    try {
      await retryJob(jobId);
      setJob(await getJob(jobId));
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not retry this job.");
    } finally {
      setActionPending(false);
    }
  }

  async function handleDelete() {
    if (!jobId) return;
    setActionPending(true);
    setActionError(null);
    try {
      await deleteJob(jobId);
      navigate("/");
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "Could not delete this job.");
      setActionPending(false);
    }
  }

  const plan = job.plan;
  const isAwaitingApproval = job.status === "awaiting_approval";
  const isTerminal = job.status === "done" || job.status === "failed" || job.status === "rejected" || job.status === "code_only";

  return (
    <>
      <div className="page-header">
        <div className="page-header__eyebrow">{job.sourceKind} · {job.sourceRef.split("/").pop()}</div>
        <div className="row">
          <h1>{plan?.blockName ?? "Analyzing…"}</h1>
          <StatusBadge status={job.status} />
          {job.costUsd != null && (
            <span className="tag" title="Total LLM cost for this job so far">
              {formatCost(job.costUsd)}
            </span>
          )}
        </div>
        {job.iteration > 0 && <p className="page-header__subtitle">Revised {job.iteration} time{job.iteration > 1 ? "s" : ""} based on feedback.</p>}
      </div>

      {job.status === "failed" && job.errorMessage && (
        <div className="callout callout--danger" style={{ marginBottom: "var(--space-4)" }}>
          <strong>Failed:</strong> {job.errorMessage}
          <div className="btn-row" style={{ marginTop: "var(--space-3)" }}>
            <button className="btn btn--secondary" onClick={handleRetry} disabled={actionPending}>
              {actionPending ? <span className="spinner" /> : null}
              Retry job
            </button>
          </div>
        </div>
      )}

      {plan && (
        <div className="card">
          <h2 className="card__title">Plan</h2>

          <div className="markdown-block" style={{ marginBottom: "var(--space-5)" }}>
            <MarkdownLite text={plan.summary} />
          </div>

          <dl className="kv-list">
            <dt>Decision</dt>
            <dd>
              <span className={`badge ${plan.reuseDecision.decision === "create" ? "badge--active" : "badge--warning"}`}>
                {plan.reuseDecision.decision}
                {(plan.reuseDecision.targetBlock ?? plan.reuseDecision.targetComponent) ? ` · ${plan.reuseDecision.targetBlock ?? plan.reuseDecision.targetComponent}` : ""}
              </span>
              <details className="decision-details">
                <summary>Why this decision?</summary>
                <p className="text-muted">{plan.reuseDecision.rationale}</p>
                {plan.reuseDecision.evidence.length > 0 && (
                  <div>
                    <strong>Repository evidence</strong>
                    <ul>
                      {plan.reuseDecision.evidence.map((item) => <li key={item}><code>{item}</code></li>)}
                    </ul>
                  </div>
                )}
                {plan.reuseDecision.gaps.length > 0 && (
                  <div>
                    <strong>Remaining gaps</strong>
                    <ul>
                      {plan.reuseDecision.gaps.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                  </div>
                )}
              </details>
            </dd>

            <dt>Files to create</dt>
            <dd>
              {plan.filesToCreate.length === 0 ? (
                <span className="text-subtle">{plan.reuseDecision.decision === "reuse" ? "none; existing component will be reused" : "none"}</span>
              ) : (
                <div className="file-list">
                  {plan.filesToCreate.map((f) => (
                    <div className="file-list__item" key={f}>
                      {f}
                    </div>
                  ))}
                </div>
              )}
            </dd>

            <dt>Files to modify</dt>
            <dd>
              {plan.filesToModify.length === 0 ? (
                <span className="text-subtle">none</span>
              ) : (
                <div className="file-list">
                  {plan.filesToModify.map((f) => (
                    <div className="file-list__item" key={f}>
                      {f}
                    </div>
                  ))}
                </div>
              )}
            </dd>

            <dt>DOM contract</dt>
            <dd className="markdown-block">
              <MarkdownLite text={plan.domContract} />
            </dd>

            <dt>UE fields</dt>
            <dd>
              <div className="tag-list">
                {plan.ueFields.map((f) => (
                  <span className="tag" key={f.name}>
                    {f.name} ({f.component}){f.required ? "*" : ""}
                  </span>
                ))}
              </div>
            </dd>

            <dt>Tokens reused</dt>
            <dd>
              <div className="tag-list">
                {plan.tokensReused.length === 0 && <span className="text-subtle">none</span>}
                {plan.tokensReused.map((t) => (
                  <span className="tag" key={t}>
                    {t}
                  </span>
                ))}
              </div>
            </dd>

            {plan.tokensNew.length > 0 && (
              <>
                <dt>New tokens</dt>
                <dd>
                  <div className="tag-list">
                    {plan.tokensNew.map((t) => (
                      <span className="tag" key={t.name} title={t.rationale}>
                        {t.name}: {t.value}
                      </span>
                    ))}
                  </div>
                </dd>
              </>
            )}

            <dt>Verification</dt>
            <dd>
              <ul style={{ margin: 0, paddingLeft: "18px" }}>
                {plan.verificationCriteria.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </dd>

            {plan.risks.length > 0 && (
              <>
                <dt>Risks</dt>
                <dd>
                  <ul style={{ margin: 0, paddingLeft: "18px" }}>
                    {plan.risks.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </dd>
              </>
            )}

            {plan.openQuestions.length > 0 && (
              <>
                <dt>Open questions</dt>
                <dd>
                  <ul style={{ margin: 0, paddingLeft: "18px" }}>
                    {plan.openQuestions.map((q, i) => (
                      <li key={i}>{q}</li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
          </dl>

          {isAwaitingApproval && (
            <div style={{ marginTop: "var(--space-6)", borderTop: "1px solid var(--color-border)", paddingTop: "var(--space-5)" }}>
              {!showFeedbackBox ? (
                <div>
                  <p style={{ marginBottom: "var(--space-4)", color: "var(--color-text-muted)" }}>
                    Choose how to proceed with this plan:
                  </p>
                  <div className="btn-row">
                    {/* <button className="btn btn--primary" onClick={handleApprove} disabled={actionPending} title="Build, verify, and write to repository with automated testing">
                      {actionPending ? <span className="spinner" /> : null}
                      Build & Verify
                    </button> */}
                    <button className="btn btn--secondary" onClick={handleApproveCodeOnly} disabled={actionPending} title="Generate and write code">
                      {actionPending ? <span className="spinner" /> : null}
                      {plan.reuseDecision.decision === "reuse" && plan.filesToCreate.length === 0 && plan.filesToModify.length === 0 ? "Finish (reuse existing)" : "Generate Code"}
                    </button>
                    <button className="btn btn--danger" onClick={() => setShowFeedbackBox(true)} disabled={actionPending}>
                      Reject with feedback
                    </button>
                  </div>
                  <div style={{ marginTop: "var(--space-3)", fontSize: "0.875rem", color: "var(--color-text-muted)" }}>
                    <p><strong>Build & Verify:</strong> Generates code, runs linting, renders screenshots, checks accessibility, and validates against the design (may take several minutes).</p>
                    <p style={{ marginTop: "var(--space-2)" }}><strong>Code Only:</strong> Generates and writes code directly without verification — you'll validate manually.</p>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="field">
                    <label htmlFor="feedback">What should change?</label>
                    <textarea
                      id="feedback"
                      value={feedback}
                      onChange={(e) => setFeedback(e.target.value)}
                      placeholder="e.g. This should extend the existing hero block instead of creating a new one."
                      autoFocus
                    />
                  </div>
                  <div className="btn-row">
                    <button className="btn btn--primary" onClick={handleReject} disabled={actionPending || !feedback.trim()}>
                      {actionPending ? <span className="spinner" /> : null}
                      Submit feedback
                    </button>
                    <button className="btn btn--secondary" onClick={() => setShowFeedbackBox(false)} disabled={actionPending}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {actionError && (
                <div className="callout callout--danger" style={{ marginTop: "var(--space-4)" }}>
                  {actionError}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {job.status === "awaiting_answers" && (
        <div className="card">
          <h2 className="card__title">Clarify requirements</h2>
          <p style={{ marginBottom: "var(--space-4)", color: "var(--color-text-muted)" }}>
            Answer these questions before the implementation plan is created.
          </p>
          {job.openQuestions.map((question) => (
            <fieldset className="field question-field" key={question.id}>
              <legend>{question.prompt}{question.required ? " *" : ""}</legend>
              {question.kind === "single_choice" ? question.options.map((option) => (
                <label className="radio-option" key={option.value}>
                  <input
                    type="radio"
                    name={question.id}
                    value={option.value}
                    checked={answerValues[question.id] === option.value}
                    onChange={(event) => setAnswerValues((current) => ({ ...current, [question.id]: event.target.value }))}
                  />
                  <span>{option.label}</span>
                </label>
              )) : (
                <textarea
                  value={answerValues[question.id] ?? ""}
                  onChange={(event) => setAnswerValues((current) => ({ ...current, [question.id]: event.target.value }))}
                  required={question.required}
                  aria-label={question.prompt}
                />
              )}
            </fieldset>
          ))}
          <div className="field">
            <label htmlFor="answer-feedback">Additional feedback (optional)</label>
            <textarea id="answer-feedback" value={answerFeedback} onChange={(event) => setAnswerFeedback(event.target.value)} />
          </div>
          <div className="btn-row">
            <button className="btn btn--primary" onClick={handleSubmitAnswers} disabled={actionPending}>
              {actionPending ? <span className="spinner" /> : null}
              Continue to planning
            </button>
          </div>
          {actionError && <div className="callout callout--danger" style={{ marginTop: "var(--space-4)" }}>{actionError}</div>}
        </div>
      )}

      {!plan && !isTerminal && job.status !== "awaiting_answers" && <div className="empty-state">Analyzing the design — a plan will appear here once ready.</div>}

      {(job.status === "deployed" || job.status === "done" || job.status === "post_feedback_building" || job.status === "post_feedback_verifying") && (
        <div className="card">
          <h2 className="card__title">Test & Refine</h2>
          <p style={{ marginBottom: "var(--space-4)", color: "var(--color-text-muted)" }}>
            The code has been deployed to your repository. Test it manually and provide feedback if any changes are needed.
          </p>
          {!showPostFeedbackBox && job.status !== "post_feedback_building" && job.status !== "post_feedback_verifying" && (
            <button className="btn btn--primary" onClick={() => setShowPostFeedbackBox(true)} disabled={actionPending}>
              Provide feedback
            </button>
          )}
          {showPostFeedbackBox && job.status !== "post_feedback_building" && job.status !== "post_feedback_verifying" && (
            <div>
              <div className="field">
                <label htmlFor="post-feedback">What should change?</label>
                <textarea
                  id="post-feedback"
                  value={postFeedback}
                  onChange={(e) => setPostFeedback(e.target.value)}
                  placeholder="e.g., The button color should match the design. Fix the spacing on mobile."
                  autoFocus
                />
              </div>
              <div className="btn-row">
                <button className="btn btn--primary" onClick={handleSubmitPostFeedback} disabled={actionPending || !postFeedback.trim()}>
                  {actionPending ? <span className="spinner" /> : null}
                  Submit feedback
                </button>
                <button className="btn btn--secondary" onClick={() => setShowPostFeedbackBox(false)} disabled={actionPending}>
                  Cancel
                </button>
              </div>
            </div>
          )}
          {(job.status === "post_feedback_building" || job.status === "post_feedback_verifying") && (
            <div className="text-subtle">
              Iterating code based on your feedback...
            </div>
          )}
        </div>
      )}

      {job.verdict && (
        <div className="card">
          <h2 className="card__title">Result</h2>

          <div
            className={`callout row ${job.verdict.pass ? "callout--neutral" : "callout--warning"}`}
            style={{ marginBottom: "var(--space-5)" }}
          >
            <span className={`badge ${job.verdict.pass ? "badge--success" : "badge--warning"}`}>{job.verdict.pass ? "Passed" : "Unresolved issues"}</span>
            <span>{job.verdict.summary}</span>
          </div>

          <dl className="kv-list">
            <dt>Checks</dt>
            <dd>
              <div className="tag-list">
                <span className={`tag ${job.verdict.lintPassed ? "" : "callout--danger"}`}>Lint: {job.verdict.lintPassed ? "pass" : "fail"}</span>
                <span className="tag">Accessibility: {job.verdict.axeViolationCount === 0 ? "clean" : `${job.verdict.axeViolationCount} violation(s)`}</span>
                <span className="tag">Attempt {job.verdict.iteration} of 3</span>
              </div>
            </dd>

            {job.verdict.screenshotUrls && job.verdict.screenshotUrls.length > 0 && (
              <>
                <dt>Rendered screenshots</dt>
                <dd>
                  <div className="row row--wrap">
                    {job.verdict.screenshotUrls.map((url) => (
                      <a href={url} target="_blank" rel="noreferrer" key={url}>
                        <img
                          src={url}
                          alt=""
                          style={{ width: "160px", height: "120px", objectFit: "cover", border: "1px solid var(--color-border)", borderRadius: "var(--radius-sm)" }}
                        />
                      </a>
                    ))}
                  </div>
                </dd>
              </>
            )}

            {job.verdict.issues.length > 0 && (
              <>
                <dt>Issues</dt>
                <dd>
                  <div className="card-list">
                    {job.verdict.issues.map((issue, i) => (
                      <div key={i} className={`callout ${issue.severity === "blocker" ? "callout--danger" : "callout--warning"}`}>
                        <strong>[{issue.severity}/{issue.area}]</strong> {issue.description}
                        {issue.suggestedFix && (
                          <div className="text-muted" style={{ marginTop: "var(--space-1)" }}>Suggested fix: {issue.suggestedFix}</div>
                        )}
                      </div>
                    ))}
                  </div>
                </dd>
              </>
            )}

            {job.writeResult && (
              <>
                <dt>Written to</dt>
                <dd>
                  {job.writeResult.mode === "git-commit" ? (
                    <span>
                      Branch <code>{job.writeResult.branchName}</code>, commit <code>{job.writeResult.commitSha?.slice(0, 8)}</code>
                    </span>
                  ) : (
                    <span>
                      Written directly to the repo.
                      {job.writeResult.backupDir && <> Originals backed up to <code>{job.writeResult.backupDir}</code>.</>}
                    </span>
                  )}
                  <div className="file-list" style={{ marginTop: "var(--space-2)" }}>
                    {job.writeResult.filesWritten.map((f) => (
                      <div className="file-list__item" key={f}>
                        {f}
                      </div>
                    ))}
                  </div>
                </dd>
              </>
            )}
          </dl>
        </div>
      )}

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: "var(--space-3)" }}>
          <h2 className="card__title">Activity</h2>
          <a className="btn btn--secondary btn--sm" href={`/api/jobs/${job.id}/agent-trace`} download={`${job.id}-agent-trace.jsonl`}>
            Download agent trace
          </a>
        </div>
        <div className="event-log" ref={logRef}>
          {events.length === 0 && <div className="text-subtle">No activity yet.</div>}
          {events.map((e, i) => (
            <div className="event-log__item" key={i}>
              <span className="event-log__ts">{new Date(e.ts).toLocaleTimeString()}</span>
              {e.agent && <span className="event-log__agent">{e.agent}</span>}
              <span>{e.message}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="btn-row">
          <button className="btn btn--danger" onClick={() => setShowDeleteDialog(true)} disabled={actionPending}>
            Delete job
          </button>
        </div>
      </div>
      {showDeleteDialog && (
        <ConfirmDialog
          title={isTerminal ? "Delete job?" : "Terminate and delete job?"}
          message={isTerminal
            ? `Delete the job for ${job.sourceRef}? This action cannot be undone.`
            : `This job is still active. It will be terminated before ${job.sourceRef} is deleted.`}
          confirmLabel={isTerminal ? "Delete" : "Terminate & Delete"}
          pending={actionPending}
          error={actionError}
          onConfirm={handleDelete}
          onCancel={() => {
            if (!actionPending) {
              setShowDeleteDialog(false);
              setActionError(null);
            }
          }}
        />
      )}
    </>
  );
}
