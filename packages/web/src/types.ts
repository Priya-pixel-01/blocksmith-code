// Mirrors the JSON shapes returned by the Blocksmith API (packages/server), which themselves
// mirror packages/core's zod schemas. Kept as plain types here (not imported from @blocksmith/core)
// so the web app builds independently of core's compiled output.

export type JobStatus =
  | "created"
  | "ingesting"
  | "analyzing"
  | "awaiting_answers"
  | "planning"
  | "awaiting_approval"
  | "code_only"
  | "building"
  | "verifying"
  | "writing"
  | "deployed"
  | "post_feedback_building"
  | "post_feedback_verifying"
  | "done"
  | "failed"
  | "rejected";

export interface BlockInfo {
  name: string;
  dir: string;
  purpose: string;
  variants: string[];
  hasUeJson: boolean;
  hasReadme: boolean;
}

export interface AemModuleInfo {
  id: string;
  path: string;
  kind: "application" | "content" | "frontend" | "backend" | "dispatcher" | "test" | "other";
}

export interface AemComponentInfo {
  id: string;
  name: string;
  path: string;
  resourceType: string | null;
}

export interface RepoProfile {
  workspaceRoot: string;
  generatedAt: string;
  isGitRepo: boolean;
  projectType: "aem" | "eds" | "mixed" | "unknown";
  classification: {
    projectType: "aem" | "eds" | "mixed" | "unknown";
    aemScore: number;
    edsScore: number;
    confidence: number;
    confidenceBand: "high" | "medium" | "low";
    evidence: Array<{
      signalId: string;
      category: string;
      path: string;
      value: string | null;
      weight: number;
      polarity: "positive" | "negative";
      explanation: string;
    }>;
    reason: string | null;
    detectorVersion: string;
  };
  modules: AemModuleInfo[];
  aemComponents: AemComponentInfo[];
  authoringSurface: {
    hasUniversalEditor: boolean;
    modelShape: "monolithic" | "fragments" | "none";
  };
  blocks: BlockInfo[];
  tokens: {
    colors: Record<string, string>;
    breakpoints: Array<{ description: string; mediaQuery: string }>;
  };
  conventions: {
    jsLinter: string | null;
    lintCommand: string | null;
  };
  digestMarkdown: string;
}

export interface Workspace {
  id: string;
  rootPath: string;
  isGitRepo: boolean;
  repoProfile: RepoProfile | null;
}

export interface OpenQuestion {
  id: string;
  prompt: string;
  kind: "text" | "single_choice";
  options: Array<{ value: string; label: string }>;
  required: boolean;
}

export interface OpenQuestionAnswer {
  questionId: string;
  value: string;
}

export interface UeField {
  name: string;
  component: string;
  label: string;
  required: boolean;
}

export interface ReuseDecision {
  decision: "create" | "extend" | "modify" | "reuse" | "variant";
  targetBlock: string | null;
  targetComponent?: string | null;
  rationale: string;
  confidence: number;
  evidence: string[];
  gaps: string[];
}

export interface Plan {
  jobId: string;
  blockName: string;
  summary: string;
  reuseDecision: ReuseDecision;
  filesToCreate: string[];
  filesToModify: string[];
  domContract: string;
  ueFields: UeField[];
  tokensReused: string[];
  tokensNew: Array<{ name: string; value: string; rationale: string }>;
  verificationCriteria: string[];
  risks: string[];
  openQuestions: string[];
}

export interface VerdictIssue {
  severity: "blocker" | "major" | "minor";
  area: "layout" | "responsive" | "accessibility" | "content" | "style" | "ue-wiring";
  description: string;
  suggestedFix: string | null;
}

export interface VerdictReport {
  pass: boolean;
  summary: string;
  issues: VerdictIssue[];
  lintPassed: boolean;
  axeViolationCount: number;
  screenshotPaths: string[];
  /** Added server-side (see routes/jobs.ts) — fetchable URLs for screenshotPaths, which are server-filesystem paths. */
  screenshotUrls?: string[];
  iteration: number;
}

export interface WriteResult {
  mode: "git-commit" | "direct-write";
  branchName: string | null;
  commitSha: string | null;
  filesWritten: string[];
  backupDir: string | null;
}

export interface Job {
  id: string;
  batchId: string;
  workspaceId: string;
  status: JobStatus;
  sourceKind: "figma" | "image" | "pdf";
  sourceRef: string;
  implementationMode: "properties" | "sling_model" | null;
  openQuestions: OpenQuestion[];
  questionAnswers: OpenQuestionAnswer[];
  blockSpec: { intent?: string | null; purpose?: string | null } | null;
  batchTitle?: string;
  plan: Plan | null;
  verdict: VerdictReport | null;
  writeResult: WriteResult | null;
  resultBranch: string | null;
  errorMessage: string | null;
  costUsd: number | null;
  iteration: number;
  feedback: string | null;
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

export interface JobEvent {
  jobId: string;
  ts: string;
  type: "status" | "agent-message" | "tool-call" | "tool-result" | "error";
  status: JobStatus | null;
  agent: string | null;
  message: string;
  data: unknown;
}
