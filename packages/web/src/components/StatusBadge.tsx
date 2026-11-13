import type { JobStatus } from "../types.js";

const VARIANTS: Record<JobStatus, { label: string; className: string }> = {
  created: { label: "Created", className: "badge--idle" },
  ingesting: { label: "Ingesting", className: "badge--active" },
  analyzing: { label: "Analyzing", className: "badge--active" },
  awaiting_answers: { label: "Awaiting answers", className: "badge--warning" },
  planning: { label: "Planning", className: "badge--active" },
  awaiting_approval: { label: "Awaiting approval", className: "badge--warning" },
  code_only: { label: "Code written", className: "badge--success" },
  building: { label: "Building", className: "badge--active" },
  verifying: { label: "Verifying", className: "badge--active" },
  writing: { label: "Writing", className: "badge--active" },
  deployed: { label: "Deployed", className: "badge--success" },
  post_feedback_building: { label: "Refining", className: "badge--active" },
  post_feedback_verifying: { label: "Verifying", className: "badge--active" },
  done: { label: "Done", className: "badge--success" },
  failed: { label: "Failed", className: "badge--danger" },
  rejected: { label: "Rejected", className: "badge--idle" },
};

export function StatusBadge({ status }: { status: JobStatus }) {
  const variant = VARIANTS[status];
  return (
    <span className={`badge ${variant.className}`}>
      <span className="badge__dot" />
      {variant.label}
    </span>
  );
}
