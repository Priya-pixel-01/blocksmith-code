import { EventEmitter } from "node:events";
import { join } from "node:path";
import pLimit, { type LimitFunction } from "p-limit";
import type { JobRepository, WorkspaceRepository, FigmaCacheRepository } from "../db/repository.js";
import type { ModelRouter } from "../llm/router.js";
import { MODEL_ROLES } from "../llm/config.js";
import { ingestFigma, ingestImage, ingestPdf } from "../ingest/index.js";
import { interpretDesign } from "../agents/interpreter.js";
import { analyzeReuse } from "../agents/reuse.js";
import { createPlan } from "../agents/planner.js";
import { buildBlock } from "../agents/builder.js";
import { interpretAemDesign } from "../agents/aem-interpreter.js";
import { analyzeAemReuse } from "../agents/aem-reuse.js";
import { createAemPlan } from "../agents/aem-planner.js";
import { buildAemComponent } from "../agents/aem-builder.js";
import { verifyAemComponent } from "../verify/aem.js";
import { verifyBlock } from "../agents/verifier.js";
import { createJobWorkspace, removeJobWorkspace } from "../workspace/isolate.js";
import { writeResult } from "../workspace/writer.js";
import { ensureWorkspaceProfile, refreshAemWorkspaceProfile } from "../workspace/setup.js";
import type { SourceArtifact } from "../schemas/source.js";
import type { BlockSpec } from "../schemas/block-spec.js";
import type { AemComponentSpec } from "../schemas/aem-spec.js";
import type { AemPlan } from "../schemas/aem-plan.js";
import type { Plan, ReuseDecision } from "../schemas/plan.js";
import type { VerdictReport } from "../schemas/verdict.js";
import type { JobEvent, JobStatus } from "../schemas/job.js";
import type { AemImplementationMode, OpenQuestionAnswer } from "../schemas/question.js";
import { applyAemImplementationMode, formatAnswers, questionsForAemSpec, questionsFromPrompts } from "./questions.js";
import { GENERIC_DESTINATION_QUESTION_ID, genericDestinationQuestion, normalizeGenericDestination } from "./generic-project.js";
import { appendAgentTraceRecord, captureTraceArtifacts, sourceTraceSummary, type AgentTraceModels } from "./agent-trace.js";

const MAX_BUILD_VERIFY_ITERATIONS = 3;

export interface JobRunnerDeps {
  jobs: JobRepository;
  workspaces: WorkspaceRepository;
  figmaCache?: FigmaCacheRepository;
  router: ModelRouter;
  /** Required only for jobs with sourceKind "figma". */
  figmaToken?: string;
  /** Where ingested source artifacts (rendered images, rasterized PDF pages), isolated job workspaces, and verification screenshots get written. */
  scratchDir: string;
  /** Optional live event bus ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â an SSE route can subscribe to `eventBus.on(jobId, handler)` for real-time updates. */
  eventBus?: EventEmitter;
  /** Max concurrent buildÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬ÂverifyÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬Âwrite pipelines (each spins up headless Chromium for rendering + a11y scanning up to 3 times). Default 2. */
  buildConcurrency?: number;
  /** Force refresh of cached data (e.g., Figma sources). Default false. */
  forceRefresh?: boolean;
}

/**
 * Drives a job through created ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ ingesting ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ analyzing ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ planning ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ awaiting_approval, and
 * handles the two things a human can do from there: approve or reject-with-feedback. Every
 * intermediate result is persisted immediately, and every status change and error is logged as a
 * JobEvent ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â so a crash mid-run leaves a job that's inspectable and resumable, not silently stuck.
 *
 * Approval hands off to building ÃƒÂ¢Ã¢â‚¬Â¡Ã¢â‚¬Å¾ verifying: the Builder writes the block into an isolated
 * workspace, the Verifier lints/renders/screenshots/scans it and critiques the render against
 * the source design, and on failure the Builder gets another pass with the Verifier's issues as
 * feedback ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â up to MAX_BUILD_VERIFY_ITERATIONS. The Writer then applies whatever the final state
 * is (a clean pass, or the last attempt if the budget ran out) to the real target repo ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â a
 * result with outstanding issues is still written and surfaced, not silently discarded, so a
 * human can see exactly what happened rather than just "it failed" with no artifact to look at.
 */
export class JobRunner {
  private buildLimit: LimitFunction;
  private traceModels: AgentTraceModels;
  private activeTasks = new Map<string, { controller: AbortController; promise: Promise<void> }>();

  constructor(private deps: JobRunnerDeps) {
    this.buildLimit = pLimit(deps.buildConcurrency ?? 2);
    this.traceModels = Object.fromEntries(MODEL_ROLES.map((role) => [role, deps.router.getModelId?.(role) ?? "unavailable"])) as AgentTraceModels;
  }

  /** Get the current forceRefresh setting. */
  getForceRefresh(): boolean {
    return this.deps.forceRefresh ?? false;
  }

  /** Set the forceRefresh flag to force re-ingestion of cached sources (e.g., Figma). */
  setForceRefresh(value: boolean): void {
    this.deps.forceRefresh = value;
  }

  async runToApproval(jobId: string): Promise<void> {
    return this.track(jobId, () => this.runToApprovalTask(jobId));
  }

  private async runToApprovalTask(jobId: string): Promise<void> {
    const job = this.deps.jobs.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);

    const workspace = this.deps.workspaces.get(job.workspaceId);
    if (!workspace) throw new Error(`Workspace ${job.workspaceId} not found`);
    if (!workspace.repoProfile) {
      throw new Error(`Workspace ${job.workspaceId} has no repo profile yet ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â run the Repo Cartographer first`);
    }

    try {
      const repoProfile = ["aem", "mixed"].includes(workspace.repoProfile.projectType)
        ? await ensureWorkspaceProfile({ workspaceId: workspace.id, rootPath: workspace.rootPath, workspaces: this.deps.workspaces, router: this.deps.router })
        : workspace.repoProfile;
      this.transition(job.id, "ingesting");
      const artifact = await this.ingest(job.id, job.sourceKind, job.sourceRef);
      this.deps.jobs.update(job.id, { sourceArtifactJson: JSON.stringify(artifact) });
      this.emit(job.id, "agent-message", "ingestor", `Ingested ${job.sourceKind} source: ${job.sourceRef}`, { source: sourceTraceSummary(artifact) });

      this.transition(job.id, "analyzing");
      if (repoProfile.projectType === "aem" || repoProfile.projectType === "mixed") {
        const implementationMode = job.implementationMode ?? "properties";
        this.emit(job.id, "agent-message", "aem-interpreter", "AEM interpretation input.", { input: { implementationMode, source: sourceTraceSummary(artifact), repositoryProfile: { digestMarkdown: repoProfile.digestMarkdown, aemComponents: repoProfile.aemComponents } } });
        const { componentSpec: interpretedSpec, costUsd: interpretCost } = await interpretAemDesign({ artifact, repoProfile, router: this.deps.router, implementationMode });
        this.deps.jobs.addCost(job.id, interpretCost);
        const componentSpec = applyAemImplementationMode(interpretedSpec, implementationMode, repoProfile);
        this.emit(job.id, "agent-message", "aem-interpreter", `Proposed AEM component: ${componentSpec.name}`, { output: componentSpec });

        const reuseRequest = {
          name: componentSpec.name,
          implementationMode,
          resourceType: componentSpec.implementation.resourceType,
          dialogPaths: componentSpec.implementation.dialog,
          htlPaths: componentSpec.implementation.htl,
          frontendAssets: componentSpec.implementation.frontend,
          backendTypes: componentSpec.implementation.backend,
        };
        this.emit(job.id, "agent-message", "aem-reuse", "AEM reuse analysis input.", { input: { request: reuseRequest, existingComponents: repoProfile.aemComponents } });
        const reuse = analyzeAemReuse(repoProfile.aemComponents, reuseRequest);
        const resolvedSpec: AemComponentSpec = { ...componentSpec, reuseDecision: reuse };
        const questions = questionsForAemSpec(resolvedSpec);
        this.deps.jobs.update(job.id, { blockSpecJson: JSON.stringify(resolvedSpec), reuseDecisionJson: JSON.stringify(reuse), openQuestionsJson: JSON.stringify(questions), questionAnswersJson: JSON.stringify([]) });
        this.emit(job.id, "agent-message", "aem-reuse", `Decision: ${reuse.decision}${reuse.targetComponent ? ` (${reuse.targetComponent})` : ""}`, { output: reuse });

        if (questions.length > 0) {
          this.transition(job.id, "awaiting_answers");
          this.emit(job.id, "agent-message", "orchestrator", `Awaiting ${questions.length} answer(s) before planning.`, { questions });
          return;
        }
        this.transition(job.id, "planning");
        this.emit(job.id, "agent-message", "aem-planner", "AEM planning input.", { input: { componentSpec: resolvedSpec, reuseDecision: reuse } });
        const { plan, costUsd: planCost } = await createAemPlan({ jobId: job.id, repoProfile, componentSpec: resolvedSpec, reuseDecision: reuse, router: this.deps.router });
        this.deps.jobs.addCost(job.id, planCost);
        this.emit(job.id, "agent-message", "aem-planner", "AEM plan created.", { output: plan });
        this.advanceAemPlan(job.id, plan);
        return;
      }
      this.emit(job.id, "agent-message", "interpreter", "EDS interpretation input.", { input: { source: sourceTraceSummary(artifact), repositoryProfile: { digestMarkdown: repoProfile.digestMarkdown, blocks: repoProfile.blocks } } });
      const { blockSpec, costUsd: interpretCost } = await interpretDesign({ artifact, repoProfile, router: this.deps.router });
      this.deps.jobs.update(job.id, { blockSpecJson: JSON.stringify(blockSpec) });
      this.deps.jobs.addCost(job.id, interpretCost);
      this.emit(job.id, "agent-message", "interpreter", `Proposed block: ${blockSpec.blockNameCandidate}`, { output: blockSpec });

      if (repoProfile.projectType === "unknown") {
        const questions = [
          genericDestinationQuestion(),
          ...questionsFromPrompts(blockSpec.openQuestions),
        ];
        const reuseDecision: ReuseDecision = {
          decision: "create",
          targetBlock: null,
          rationale: "No supported project adapter was detected; create a standalone component in the user-selected folder.",
          confidence: 1,
          category: "new-component-required",
          evidence: ["Project classification is unknown."],
          gaps: ["Framework-specific application wiring is unavailable in the generic fallback."],
        };
        this.deps.jobs.update(job.id, {
          blockSpecJson: JSON.stringify(blockSpec),
          reuseDecisionJson: JSON.stringify(reuseDecision),
          openQuestionsJson: JSON.stringify(questions),
          questionAnswersJson: JSON.stringify([]),
        });
        this.transition(job.id, "awaiting_answers");
        this.emit(job.id, "agent-message", "orchestrator", "This repository does not match the supported AEM or EDS structures. Select a destination folder before planning files.", { questions, fallback: "standalone-html-css-js" });
        return;
      }

      this.emit(job.id, "agent-message", "reuse", "EDS reuse analysis input.", { input: { blockSpec, repositoryProfile: repoProfile.blocks } });
      const { reuseDecision, costUsd: reuseCost } = await analyzeReuse({ root: workspace.rootPath, repoProfile, blockSpec, router: this.deps.router });
      this.deps.jobs.update(job.id, { reuseDecisionJson: JSON.stringify(reuseDecision), openQuestionsJson: JSON.stringify([]), questionAnswersJson: JSON.stringify([]) });
      this.deps.jobs.addCost(job.id, reuseCost);
      this.emit(job.id, "agent-message", "reuse", `Decision: ${reuseDecision.decision}${reuseDecision.targetBlock ? ` (${reuseDecision.targetBlock})` : ""}`, { output: reuseDecision });

      this.transition(job.id, "planning");
      this.emit(job.id, "agent-message", "planner", "EDS planning input.", { input: { blockSpec, reuseDecision } });
      const { plan, costUsd: planCost } = await createPlan({ jobId: job.id, repoProfile, blockSpec, reuseDecision, router: this.deps.router });
      this.deps.jobs.update(job.id, { planJson: JSON.stringify(plan) });
      this.deps.jobs.addCost(job.id, planCost);
      this.emit(job.id, "agent-message", "planner", "Plan created.", { output: plan });

      this.transition(job.id, "awaiting_approval");
    } catch (err) {
      if (this.isCancellationRequested(job.id)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.emit(job.id, "error", null, message);
      this.transition(job.id, "failed", message);
      throw err;
    }
  }

  async answerQuestions(jobId: string, answers: OpenQuestionAnswer[], additionalFeedback = ""): Promise<void> {
    return this.track(jobId, () => this.answerQuestionsTask(jobId, answers, additionalFeedback));
  }

  private async answerQuestionsTask(jobId: string, answers: OpenQuestionAnswer[], additionalFeedback: string): Promise<void> {
    const job = this.deps.jobs.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (job.status !== "awaiting_answers") throw new Error(`Job ${jobId} is not awaiting answers (status: ${job.status})`);
    const questionById = new Map(job.openQuestions.map((question) => [question.id, question]));
    for (const answer of answers) {
      const question = questionById.get(answer.questionId);
      if (!question) throw new Error(`Unknown question: ${answer.questionId}`);
      if (question.kind === "single_choice" && !question.options.some((option) => option.value === answer.value)) {
        throw new Error(`Invalid choice for question ${question.id}`);
      }
    }
    const required = job.openQuestions.filter((question) => question.required).map((question) => question.id);
    if (required.some((id) => !answers.some((answer) => answer.questionId === id && answer.value.trim()))) throw new Error("Every required question must be answered");
    const answerFeedback = [`## User answers before planning\n${formatAnswers(job.openQuestions, answers)}`, additionalFeedback.trim() ? `## Additional user feedback\n${additionalFeedback.trim()}` : ""].filter(Boolean).join("\n\n");
    const workspace = this.deps.workspaces.get(job.workspaceId);
    if (!workspace?.repoProfile || !job.blockSpec) throw new Error(`Job ${jobId} is missing its repository profile or component specification`);
    if (workspace.repoProfile.projectType === "unknown") {
      const savedSpec = job.blockSpec as BlockSpec;
      const destinationAnswer = answers.find((answer) => answer.questionId === GENERIC_DESTINATION_QUESTION_ID);
      const targetDirectory = destinationAnswer
        ? normalizeGenericDestination(destinationAnswer.value)
        : savedSpec.targetDirectory;
      if (targetDirectory === undefined || targetDirectory === null) {
        throw new Error("Choose a destination folder before planning files for this repository.");
      }
      const updatedSpec: BlockSpec = { ...savedSpec, targetDirectory, openQuestions: [] };
      const reuseDecision: ReuseDecision = {
        decision: "create",
        targetBlock: null,
        rationale: "No supported project adapter was detected; create a standalone component in the user-selected folder.",
        confidence: 1,
        category: "new-component-required",
        evidence: ["Project classification is unknown."],
        gaps: ["Framework-specific application wiring is unavailable in the generic fallback."],
      };
      this.deps.jobs.update(job.id, {
        blockSpecJson: JSON.stringify(updatedSpec),
        reuseDecisionJson: JSON.stringify(reuseDecision),
        openQuestionsJson: JSON.stringify([]),
        questionAnswersJson: JSON.stringify(answers),
        feedback: [job.feedback, answerFeedback].filter(Boolean).join("\n\n---\n\n"),
      });
      this.emit(job.id, "agent-message", "human", "Generic project destination selected.", { targetDirectory: targetDirectory || ".", answers });
      this.transition(job.id, "planning");
      try {
        const { plan, costUsd } = await createPlan({
          jobId: job.id,
          repoProfile: workspace.repoProfile,
          blockSpec: updatedSpec,
          reuseDecision,
          router: this.deps.router,
          feedback: answerFeedback,
        });
        this.deps.jobs.addCost(job.id, costUsd);
        this.emit(job.id, "agent-message", "planner", "Standalone component plan created.", { output: plan });
        this.advanceAemPlan(job.id, plan);
      } catch (err) {
        if (this.isCancellationRequested(job.id)) throw err;
        const message = err instanceof Error ? err.message : String(err);
        this.emit(job.id, "error", "planner", message);
        this.transition(job.id, "failed", message);
        throw err;
      }
      return;
    }
    if (!["aem", "mixed"].includes(workspace.repoProfile.projectType)) throw new Error("Pre-planning answers are currently supported for AEM jobs only");

    const implementationMode: AemImplementationMode = job.implementationMode ?? "properties";
    const savedSpec = job.blockSpec as AemComponentSpec;
    const parentPathAnswer = answers.find((answer) => answer.questionId === "component-parent-path");
    const selectedParentPath = parentPathAnswer?.value.trim();
    const updatedSpec = applyAemImplementationMode({
      ...savedSpec,
      parentPath: selectedParentPath ? selectedParentPath : savedSpec.parentPath ?? null,
      requirements: [...savedSpec.requirements, answerFeedback],
      openQuestions: [],
    }, implementationMode, workspace.repoProfile);
    const reuseRequest = {
      name: updatedSpec.name,
      implementationMode,
      resourceType: updatedSpec.implementation.resourceType,
      dialogPaths: updatedSpec.implementation.dialog,
      htlPaths: updatedSpec.implementation.htl,
      frontendAssets: updatedSpec.implementation.frontend,
      backendTypes: updatedSpec.implementation.backend,
    };
    this.emit(job.id, "agent-message", "aem-reuse", "AEM reuse analysis input after clarification.", { input: { request: reuseRequest, existingComponents: workspace.repoProfile.aemComponents } });
    const reuse = analyzeAemReuse(workspace.repoProfile.aemComponents, reuseRequest);
    const resolvedSpec = { ...updatedSpec, reuseDecision: reuse };
    this.deps.jobs.update(job.id, {
      blockSpecJson: JSON.stringify(resolvedSpec),
      reuseDecisionJson: JSON.stringify(reuse),
      questionAnswersJson: JSON.stringify(answers),
      feedback: [job.feedback, answerFeedback].filter(Boolean).join("\n\n---\n\n"),
    });
    this.emit(job.id, "agent-message", "human", "Clarification answers submitted.", { answers, additionalFeedback, implementationMode, updatedSpecification: resolvedSpec, reuseDecision: reuse });
    this.transition(job.id, "planning");
    try {
      this.emit(job.id, "agent-message", "aem-planner", "AEM planning input after clarification.", { input: { componentSpec: resolvedSpec, reuseDecision: reuse, answers, additionalFeedback } });
      const { plan, costUsd } = await createAemPlan({ jobId: job.id, repoProfile: workspace.repoProfile, componentSpec: resolvedSpec, reuseDecision: reuse, router: this.deps.router, feedback: answerFeedback });
      this.deps.jobs.addCost(job.id, costUsd);
      this.emit(job.id, "agent-message", "aem-planner", "AEM plan created from user answers.", { output: plan });
      this.advanceAemPlan(job.id, plan);
    } catch (err) {
      if (this.isCancellationRequested(job.id)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.emit(job.id, "error", "planner", message);
      this.transition(job.id, "failed", message);
      throw err;
    }
  }
  /** Re-runs Interpreter ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Reuse ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ Planner with feedback appended, from a job's already-ingested source artifact. */
  async reject(jobId: string, feedback: string): Promise<void> {
    return this.track(jobId, () => this.rejectTask(jobId, feedback));
  }

  private async rejectTask(jobId: string, feedback: string): Promise<void> {
    const job = this.deps.jobs.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (job.status !== "awaiting_approval") {
      throw new Error(`Job ${jobId} is not awaiting approval (status: ${job.status})`);
    }
    if (!job.sourceArtifact) {
      throw new Error(`Job ${jobId} has no ingested source artifact to re-plan from`);
    }

    const workspace = this.deps.workspaces.get(job.workspaceId);
    if (!workspace?.repoProfile) {
      throw new Error(`Workspace ${job.workspaceId} has no repo profile`);
    }

    const accumulatedFeedback = job.feedback ? `${job.feedback}\n\n---\n\n${feedback}` : feedback;
    this.deps.jobs.update(job.id, { feedback: accumulatedFeedback, iteration: job.iteration + 1 });
    this.emit(job.id, "agent-message", "orchestrator", `Plan rejected, re-running with feedback: ${feedback}`);

    try {
      this.transition(job.id, "analyzing");
      if (workspace.repoProfile.projectType === "aem" || workspace.repoProfile.projectType === "mixed") {
        const implementationMode = job.implementationMode ?? "properties";
        const { componentSpec: interpretedSpec, costUsd: interpretCost } = await interpretAemDesign({ artifact: job.sourceArtifact as SourceArtifact, repoProfile: workspace.repoProfile, router: this.deps.router, implementationMode, feedback: accumulatedFeedback });
        this.deps.jobs.addCost(job.id, interpretCost);
        const componentSpec = applyAemImplementationMode(interpretedSpec, implementationMode, workspace.repoProfile);
        this.emit(job.id, "agent-message", "aem-interpreter", `Revised AEM component: ${componentSpec.name}`, { output: componentSpec, feedback: accumulatedFeedback });
        const reuse = analyzeAemReuse(workspace.repoProfile.aemComponents, {
          name: componentSpec.name,
          implementationMode,
          resourceType: componentSpec.implementation.resourceType,
          dialogPaths: componentSpec.implementation.dialog,
          htlPaths: componentSpec.implementation.htl,
          frontendAssets: componentSpec.implementation.frontend,
          backendTypes: componentSpec.implementation.backend,
        });
        this.emit(job.id, "agent-message", "aem-reuse", `Revised decision: ${reuse.decision}${reuse.targetComponent ? ` (${reuse.targetComponent})` : ""}`, { output: reuse });
        const resolvedSpec: AemComponentSpec = { ...componentSpec, reuseDecision: reuse };
        const questions = questionsForAemSpec(resolvedSpec);
        this.deps.jobs.update(job.id, { blockSpecJson: JSON.stringify(resolvedSpec), reuseDecisionJson: JSON.stringify(reuse), openQuestionsJson: JSON.stringify(questions), questionAnswersJson: JSON.stringify([]) });
        if (questions.length > 0) {
          this.transition(job.id, "awaiting_answers");
          this.emit(job.id, "agent-message", "orchestrator", `Awaiting ${questions.length} answer(s) before planning.`, { questions });
          return;
        }
        this.transition(job.id, "planning");
        const { plan, costUsd: planCost } = await createAemPlan({ jobId: job.id, repoProfile: workspace.repoProfile, componentSpec: resolvedSpec, reuseDecision: reuse, router: this.deps.router, feedback: accumulatedFeedback });
        this.deps.jobs.addCost(job.id, planCost);
        this.emit(job.id, "agent-message", "aem-planner", "Revised AEM plan created.", { output: plan });
        this.advanceAemPlan(job.id, plan);
        return;
      }
      const artifact = job.sourceArtifact as SourceArtifact;
      const { blockSpec, costUsd: interpretCost } = await interpretDesign({ artifact, repoProfile: workspace.repoProfile, router: this.deps.router, feedback: accumulatedFeedback });
      this.deps.jobs.update(job.id, { blockSpecJson: JSON.stringify(blockSpec) });
      this.deps.jobs.addCost(job.id, interpretCost);
      this.emit(job.id, "agent-message", "interpreter", "Revised block specification.", { output: blockSpec, feedback: accumulatedFeedback });

      if (workspace.repoProfile.projectType === "unknown") {
        const previousSpec = job.blockSpec as BlockSpec;
        const destination = previousSpec.targetDirectory;
        const reuseDecision: ReuseDecision = {
          decision: "create",
          targetBlock: null,
          rationale: "No supported project adapter was detected; create a standalone component in the user-selected folder.",
          confidence: 1,
          category: "new-component-required",
          evidence: ["Project classification is unknown."],
          gaps: ["Framework-specific application wiring is unavailable in the generic fallback."],
        };
        const revisedSpec: BlockSpec = { ...blockSpec, targetDirectory: destination ?? null };
        if (destination === undefined || destination === null) {
          const questions = [genericDestinationQuestion(), ...questionsFromPrompts(revisedSpec.openQuestions)];
          this.deps.jobs.update(job.id, {
            blockSpecJson: JSON.stringify(revisedSpec),
            reuseDecisionJson: JSON.stringify(reuseDecision),
            openQuestionsJson: JSON.stringify(questions),
            questionAnswersJson: JSON.stringify([]),
          });
          this.transition(job.id, "awaiting_answers");
          this.emit(job.id, "agent-message", "orchestrator", "Select a destination folder before replanning this generic component.", { questions });
          return;
        }
        revisedSpec.openQuestions = [];
        this.deps.jobs.update(job.id, {
          blockSpecJson: JSON.stringify(revisedSpec),
          reuseDecisionJson: JSON.stringify(reuseDecision),
          openQuestionsJson: JSON.stringify([]),
          questionAnswersJson: JSON.stringify([]),
        });
        this.transition(job.id, "planning");
        const { plan, costUsd: planCost } = await createPlan({
          jobId: job.id,
          repoProfile: workspace.repoProfile,
          blockSpec: revisedSpec,
          reuseDecision,
          router: this.deps.router,
          feedback: accumulatedFeedback,
        });
        this.deps.jobs.addCost(job.id, planCost);
        this.emit(job.id, "agent-message", "planner", "Revised standalone component plan created.", { output: plan });
        this.advanceAemPlan(job.id, plan);
        return;
      }

      const { reuseDecision, costUsd: reuseCost } = await analyzeReuse({
        root: workspace.rootPath,
        repoProfile: workspace.repoProfile,
        blockSpec,
        router: this.deps.router,
        feedback: accumulatedFeedback,
      });
      this.emit(job.id, "agent-message", "reuse", `Revised decision: ${reuseDecision.decision}${reuseDecision.targetBlock ? ` (${reuseDecision.targetBlock})` : ""}`, { output: reuseDecision });
      this.deps.jobs.update(job.id, { reuseDecisionJson: JSON.stringify(reuseDecision), openQuestionsJson: JSON.stringify([]), questionAnswersJson: JSON.stringify([]) });
      this.deps.jobs.addCost(job.id, reuseCost);

      this.transition(job.id, "planning");
      const { plan, costUsd: planCost } = await createPlan({
        jobId: job.id,
        repoProfile: workspace.repoProfile,
        blockSpec,
        reuseDecision,
        router: this.deps.router,
        feedback: accumulatedFeedback,
      });
      this.deps.jobs.update(job.id, { planJson: JSON.stringify(plan) });
      this.deps.jobs.addCost(job.id, planCost);
      this.emit(job.id, "agent-message", "planner", "Revised plan created.", { output: plan });

      this.transition(job.id, "awaiting_approval");
    } catch (err) {
      if (this.isCancellationRequested(job.id)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.emit(job.id, "error", null, message);
      this.transition(job.id, "failed", message);
      throw err;
    }
  }

  /**
   * Approves the plan for code generation only ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â skips verification and writes directly to the
   * target repo. Use when the human will validate and refine the code themselves.
   */
  async approveCodeOnly(jobId: string): Promise<void> {
    return this.track(jobId, () => this.approveCodeOnlyTask(jobId));
  }

  private async approveCodeOnlyTask(jobId: string): Promise<void> {
    const job = this.deps.jobs.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (job.status !== "awaiting_approval") {
      throw new Error(`Job ${jobId} is not awaiting approval (status: ${job.status})`);
    }
    if (!job.plan) {
      throw new Error(`Job ${jobId} is missing its plan ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â cannot build`);
    }
    if (!job.sourceArtifact) {
      throw new Error(`Job ${jobId} is missing its source artifact — cannot build`);
    }

    const workspace = this.deps.workspaces.get(job.workspaceId);
    if (!workspace?.repoProfile) {
      throw new Error(`Workspace ${job.workspaceId} has no repo profile`);
    }

    if (workspace.repoProfile.projectType === "aem" || workspace.repoProfile.projectType === "mixed") {
      await this.approveAemCodeOnly(job, workspace.rootPath, workspace.isGitRepo, workspace.repoProfile);
      return;
    }

    const plan = job.plan as Plan;
    const { router } = this.deps;

    let jobWorkspace: Awaited<ReturnType<typeof createJobWorkspace>> | null = null;
    try {
      jobWorkspace = await createJobWorkspace({
        targetRoot: workspace.rootPath,
        scratchDir: this.deps.scratchDir,
        jobId: job.id,
        blockName: plan.blockName,
        isGitRepo: workspace.isGitRepo,
      });
      this.deps.jobs.update(job.id, { workspaceDir: jobWorkspace.dir });

      this.transition(job.id, "building");
      this.emit(job.id, "agent-message", "builder", "Code-only builder input.", { input: { blockSpec: job.blockSpec, plan, approvedFiles: [...plan.filesToCreate, ...plan.filesToModify] } });
      const build = await buildBlock({
        workspaceDir: jobWorkspace.dir,
        repoProfile: workspace.repoProfile,
        blockSpec: job.blockSpec as BlockSpec,
        plan,
        sourceArtifact: job.sourceArtifact as SourceArtifact,
        router,
      });
      this.deps.jobs.addCost(job.id, build.costUsd);
      this.emit(job.id, "agent-message", "builder", `Code-only mode: wrote ${build.filesWritten.length}/${build.filesWritten.length + build.filesMissing.length} planned files. ${build.summary}`, { output: build, artifacts: captureTraceArtifacts(jobWorkspace.dir, build.filesWritten) });
      if (build.filesMissing.length > 0) {
        this.emit(job.id, "agent-message", "builder", `Missing files after build: ${build.filesMissing.join(", ")}`, { missingFiles: build.filesMissing });
      }

      this.transition(job.id, "writing");
      const write = await writeResult({
        targetRoot: workspace.rootPath,
        workspace: jobWorkspace,
        jobId: job.id,
        blockName: plan.blockName,
        filesToCreate: plan.filesToCreate,
        filesToModify: plan.filesToModify,
        writeDirectly: true,
        allowGenericPaths: workspace.repoProfile.projectType === "unknown",
      });
      this.deps.jobs.update(job.id, { writeResultJson: JSON.stringify(write), resultBranch: write.branchName });
      this.emit(job.id, "agent-message", "writer", write.mode === "git-commit" ? `Committed to branch ${write.branchName} (${write.commitSha?.slice(0, 8)})` : `Written directly to ${workspace.rootPath}${write.backupDir ? ` (originals backed up to ${write.backupDir})` : ""}`);

      this.transition(job.id, "code_only");
      this.emit(job.id, "agent-message", "orchestrator", "Code generated and written. Review and test the code manually.");
    } catch (err) {
      if (this.isCancellationRequested(job.id)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.emit(job.id, "error", null, message);
      this.transition(job.id, "failed", message);
      throw err;
    } finally {
      if (jobWorkspace) await removeJobWorkspace(workspace.rootPath, jobWorkspace).catch(() => {});
    }
  }

  /**
   * Approves the plan and runs it through the build ÃƒÂ¢Ã¢â‚¬Â¡Ã¢â‚¬Å¾ verify loop, then writes the result to the
   * target repo. Gated by buildLimit: each attempt spins up headless Chromium for rendering + a11y
   * scanning up to MAX_BUILD_VERIFY_ITERATIONS times, so several jobs approved close together must
   * not all run their pipelines at once.
   */
  async approve(jobId: string): Promise<void> {
    return this.track(jobId, () => this.buildLimit(() => this.runApprovedPipeline(jobId)));
  }

  private async runApprovedPipeline(jobId: string): Promise<void> {
    const job = this.deps.jobs.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (job.status !== "awaiting_approval") {
      throw new Error(`Job ${jobId} is not awaiting approval (status: ${job.status})`);
    }
    if (!job.plan || !job.sourceArtifact) {
      throw new Error(`Job ${jobId} is missing its plan or source artifact ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â cannot build`);
    }

    const workspace = this.deps.workspaces.get(job.workspaceId);
    if (!workspace?.repoProfile) {
      throw new Error(`Workspace ${job.workspaceId} has no repo profile`);
    }

    if (workspace.repoProfile.projectType === "aem" || workspace.repoProfile.projectType === "mixed") {
      await this.runApprovedAemPipeline(job, workspace.rootPath, workspace.isGitRepo, workspace.repoProfile);
      return;
    }

    const plan = job.plan as Plan;
    const sourceArtifact = job.sourceArtifact as SourceArtifact;
    const { router } = this.deps;

    let jobWorkspace: Awaited<ReturnType<typeof createJobWorkspace>> | null = null;
    try {
      jobWorkspace = await createJobWorkspace({
        targetRoot: workspace.rootPath,
        scratchDir: this.deps.scratchDir,
        jobId: job.id,
        blockName: plan.blockName,
        isGitRepo: workspace.isGitRepo,
      });
      this.deps.jobs.update(job.id, { workspaceDir: jobWorkspace.dir });

      let verdict: VerdictReport | null = null;
      let feedback: string | undefined;

      for (let iteration = 1; iteration <= MAX_BUILD_VERIFY_ITERATIONS; iteration++) {
        this.transition(job.id, "building");
        this.emit(job.id, "agent-message", "builder", `Builder input, iteration ${iteration}.`, { input: { blockSpec: job.blockSpec, plan, feedback } });
        const build = await buildBlock({ workspaceDir: jobWorkspace.dir, repoProfile: workspace.repoProfile, blockSpec: job.blockSpec as BlockSpec, plan, sourceArtifact, router, feedback });
        this.deps.jobs.addCost(job.id, build.costUsd);
        this.emit(job.id, "agent-message", "builder", `Iteration ${iteration}: wrote ${build.filesWritten.length}/${build.filesWritten.length + build.filesMissing.length} planned files. ${build.summary}`, { iteration, output: build, artifacts: captureTraceArtifacts(jobWorkspace.dir, build.filesWritten) });
        if (build.filesMissing.length > 0) {
          this.emit(job.id, "agent-message", "builder", `Missing files after build: ${build.filesMissing.join(", ")}`, { iteration, missingFiles: build.filesMissing });
        }

        this.transition(job.id, "verifying");
        this.emit(job.id, "agent-message", "verifier", `Verifier input, iteration ${iteration}.`, { input: { plan, source: sourceTraceSummary(sourceArtifact), generatedFiles: build.filesWritten, lint: build.lint } });
        const verifyResult = await verifyBlock({
          workspaceDir: jobWorkspace.dir,
          repoProfile: workspace.repoProfile,
          plan,
          sourceArtifact,
          router,
          outDir: join(this.deps.scratchDir, job.id, `verify-${iteration}`),
          iteration,
        });
        verdict = verifyResult.verdict;
        this.deps.jobs.update(job.id, { verdictJson: JSON.stringify(verdict) });
        this.deps.jobs.addCost(job.id, verifyResult.costUsd);
        this.emit(job.id, "agent-message", "verifier", `Iteration ${iteration}: ${verdict.pass ? "passed" : `${verdict.issues.length} issue(s) found`} (lint: ${verdict.lintPassed ? "pass" : "fail"}, a11y violations: ${verdict.axeViolationCount})`, { iteration, output: verdict });

        if (verdict.pass) break;
        if (iteration < MAX_BUILD_VERIFY_ITERATIONS) {
          feedback = summarizeVerdictForRebuild(verdict);
        }
      }

      if (!verdict) throw new Error("Verifier never ran"); // unreachable ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â loop always runs at least once

      if (!verdict.pass) {
        this.emit(job.id, "agent-message", "orchestrator", `Reached the ${MAX_BUILD_VERIFY_ITERATIONS}-iteration limit without a clean pass ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â writing the last attempt with its outstanding issues rather than discarding the work.`);
      }

      this.transition(job.id, "writing");
      const write = await writeResult({
        targetRoot: workspace.rootPath,
        workspace: jobWorkspace,
        jobId: job.id,
        blockName: plan.blockName,
        filesToCreate: plan.filesToCreate,
        filesToModify: plan.filesToModify,
        allowGenericPaths: workspace.repoProfile.projectType === "unknown",
      });
      this.deps.jobs.update(job.id, { writeResultJson: JSON.stringify(write), resultBranch: write.branchName });
      this.emit(job.id, "agent-message", "writer", write.mode === "git-commit" ? `Committed to branch ${write.branchName} (${write.commitSha?.slice(0, 8)})` : `Written directly to ${workspace.rootPath}${write.backupDir ? ` (originals backed up to ${write.backupDir})` : ""}`);

      this.transition(job.id, "deployed");
      this.emit(job.id, "agent-message", "orchestrator", "Code deployed to repo. Ready for testing and post-deployment feedback via POST /api/jobs/{jobId}/post-feedback");
    } catch (err) {
      if (this.isCancellationRequested(job.id)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.emit(job.id, "error", null, message);
      this.transition(job.id, "failed", message);
      throw err;
    } finally {
      if (jobWorkspace) await removeJobWorkspace(workspace.rootPath, jobWorkspace).catch(() => {});
    }
  }

  private async approveAemCodeOnly(job: NonNullable<ReturnType<JobRepository["getJob"]>>, rootPath: string, isGitRepo: boolean, repoProfile: NonNullable<ReturnType<WorkspaceRepository["get"]>>["repoProfile"]): Promise<void> {
    if (!job.plan || !job.blockSpec || !job.sourceArtifact || !repoProfile) throw new Error(`AEM job ${job.id} is missing its plan, specification, source artifact, or repository profile`);
    const plan = job.plan as AemPlan;
    const componentSpec = job.blockSpec as AemComponentSpec;
    if (plan.reuseDecision.decision === "reuse" && plan.filePlan.filesToCreate.length === 0 && plan.filePlan.filesToModify.length === 0) {
      this.transition(job.id, "done");
      this.emit(job.id, "agent-message", "orchestrator", "The existing component already satisfies this request; no files were generated.");
      return;
    }
    let jobWorkspace: Awaited<ReturnType<typeof createJobWorkspace>> | null = null;
    try {
      jobWorkspace = await createJobWorkspace({ targetRoot: rootPath, scratchDir: this.deps.scratchDir, jobId: job.id, blockName: plan.componentName, isGitRepo });
      this.deps.jobs.update(job.id, { workspaceDir: jobWorkspace.dir });
      this.transition(job.id, "building");
      this.emit(job.id, "agent-message", "aem-builder", "AEM builder input.", { input: { componentSpec, plan, approvedFiles: [...plan.filePlan.filesToCreate, ...plan.filePlan.filesToModify] } });
      const build = await buildAemComponent({ workspaceDir: jobWorkspace.dir, repoProfile, componentSpec, plan, sourceArtifact: job.sourceArtifact as SourceArtifact, router: this.deps.router });
      this.deps.jobs.addCost(job.id, build.costUsd);
      this.emit(job.id, "agent-message", "aem-builder", `Code-only mode: wrote ${build.filesWritten.length}/${build.filesWritten.length + build.filesMissing.length} planned AEM files.`, { output: build, artifacts: captureTraceArtifacts(jobWorkspace.dir, build.filesWritten) });
      this.transition(job.id, "writing");
      const write = await writeResult({ targetRoot: rootPath, workspace: jobWorkspace, jobId: job.id, blockName: plan.componentName, filesToCreate: plan.filePlan.filesToCreate, filesToModify: plan.filePlan.filesToModify, writeDirectly: true });
      this.deps.jobs.update(job.id, { writeResultJson: JSON.stringify(write), resultBranch: write.branchName });
      refreshAemWorkspaceProfile({ workspaceId: job.workspaceId, workspaceDir: rootPath, workspaces: this.deps.workspaces });
      this.transition(job.id, "code_only");
    } catch (err) {
      if (this.isCancellationRequested(job.id)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.emit(job.id, "error", "aem-builder", message);
      this.transition(job.id, "failed", message);
      throw err;
    } finally {
      if (jobWorkspace) await removeJobWorkspace(rootPath, jobWorkspace).catch(() => {});
    }
  }

  private advanceAemPlan(jobId: string, plan: Plan | AemPlan): void {
    const questions = questionsFromPrompts(plan.openQuestions);
    this.deps.jobs.update(jobId, {
      planJson: JSON.stringify(plan),
      openQuestionsJson: JSON.stringify(questions),
      questionAnswersJson: questions.length > 0 ? JSON.stringify([]) : JSON.stringify(this.deps.jobs.getJob(jobId)?.questionAnswers ?? []),
    });
    if (questions.length > 0) {
      this.transition(jobId, "awaiting_answers");
      this.emit(jobId, "agent-message", "orchestrator", `The planner found ${questions.length} additional clarification question(s). Answer them before approval.`, { questions, plan });
      return;
    }
    this.transition(jobId, "awaiting_approval");
  }

  private async runApprovedAemPipeline(job: NonNullable<ReturnType<JobRepository["getJob"]>>, rootPath: string, isGitRepo: boolean, repoProfile: NonNullable<ReturnType<WorkspaceRepository["get"]>>["repoProfile"]): Promise<void> {
    if (!job.plan || !job.blockSpec || !job.sourceArtifact || !repoProfile) throw new Error(`AEM job ${job.id} is missing its plan, specification, source artifact, or repository profile`);
    const plan = job.plan as AemPlan;
    const componentSpec = job.blockSpec as AemComponentSpec;
    if (plan.reuseDecision.decision === "reuse" && plan.filePlan.filesToCreate.length === 0 && plan.filePlan.filesToModify.length === 0) {
      this.transition(job.id, "done");
      this.emit(job.id, "agent-message", "orchestrator", "The existing component already satisfies this request; no files were generated.");
      return;
    }
    let jobWorkspace: Awaited<ReturnType<typeof createJobWorkspace>> | null = null;
    try {
      jobWorkspace = await createJobWorkspace({ targetRoot: rootPath, scratchDir: this.deps.scratchDir, jobId: job.id, blockName: plan.componentName, isGitRepo });
      this.deps.jobs.update(job.id, { workspaceDir: jobWorkspace.dir });
      this.transition(job.id, "building");
      const build = await buildAemComponent({ workspaceDir: jobWorkspace.dir, repoProfile, componentSpec, plan, sourceArtifact: job.sourceArtifact as SourceArtifact, router: this.deps.router });
      this.deps.jobs.addCost(job.id, build.costUsd);
      this.emit(job.id, "agent-message", "aem-builder", `Generated ${build.filesWritten.length}/${build.filesWritten.length + build.filesMissing.length} planned AEM files. Lint: ${build.lint.passed ? "pass" : "fail"}.`, { output: build, artifacts: captureTraceArtifacts(jobWorkspace.dir, build.filesWritten) });
      this.transition(job.id, "verifying");
      this.emit(job.id, "agent-message", "aem-verifier", "Deterministic AEM verifier input.", { input: { componentSpec, plan, generatedFiles: build.filesWritten, lint: build.lint } });
      const verdict = await verifyAemComponent({ workspaceDir: jobWorkspace.dir, repoProfile, componentSpec, plan });
      this.deps.jobs.update(job.id, { verdictJson: JSON.stringify(verdict) });
      this.emit(job.id, "agent-message", "aem-verifier", `${verdict.pass ? "AEM validation passed" : `AEM validation found ${verdict.issues.length} issue(s)`}; browser rendering: ${verdict.renderAvailable ? "available" : "not available without an AEM runtime"}`, { output: verdict, verifierType: "deterministic" });
      if (!verdict.pass) throw new Error(verdict.summary);
      this.transition(job.id, "writing");
      const write = await writeResult({ targetRoot: rootPath, workspace: jobWorkspace, jobId: job.id, blockName: plan.componentName, filesToCreate: plan.filePlan.filesToCreate, filesToModify: plan.filePlan.filesToModify });
      this.deps.jobs.update(job.id, { writeResultJson: JSON.stringify(write), resultBranch: write.branchName });
      this.transition(job.id, "deployed");
      this.emit(job.id, "agent-message", "orchestrator", "AEM component generated and written. AEM-specific rendering verification is not yet enabled.");
    } catch (err) {
      if (this.isCancellationRequested(job.id)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.emit(job.id, "error", "aem-builder", message);
      this.transition(job.id, "failed", message);
      throw err;
    } finally {
      if (jobWorkspace) await removeJobWorkspace(rootPath, jobWorkspace).catch(() => {});
    }
  }

  /**
   * Post-deployment feedback loop: agent holds knowledge of what was built, user tests the code,
   * provides feedback, and agent iterates on the deployed code to match feedback.
   * 
   * This method:
   * 1. Takes feedback on the already-deployed code
   * 2. Re-runs Builder with the feedback and existing artifacts
   * 3. Optionally re-verifies the changes
   * 4. Commits the iterative updates to the target repo
   */
  async refineAfterDeployment(jobId: string, postFeedback: string): Promise<void> {
    return this.track(jobId, () => this.buildLimit(() => this.runPostFeedbackRefinement(jobId, postFeedback)));
  }

  private async runPostFeedbackRefinement(jobId: string, postFeedback: string): Promise<void> {
    const job = this.deps.jobs.getJob(jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (job.status !== "deployed" && job.status !== "done") {
      throw new Error(`Job ${jobId} is not deployed (status: ${job.status}) ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â cannot refine`);
    }
    if (!job.plan || !job.blockSpec || !job.sourceArtifact) {
      throw new Error(`Job ${jobId} is missing plan, blockSpec, or source artifact — cannot refine`);
    }

    const workspace = this.deps.workspaces.get(job.workspaceId);
    if (!workspace?.repoProfile) {
      throw new Error(`Workspace ${job.workspaceId} has no repo profile`);
    }

    if (workspace.repoProfile.projectType === "aem" || workspace.repoProfile.projectType === "mixed") {
      await this.runAemPostFeedbackRefinement(job, postFeedback, workspace.rootPath, workspace.isGitRepo, workspace.repoProfile);
      return;
    }

    const plan = job.plan as Plan;
    const blockSpec = job.blockSpec as BlockSpec;
    const accumulatedFeedback = job.feedback ? `${job.feedback}\n\n---\n\n${postFeedback}` : postFeedback;
    const nextIteration = job.iteration + 1;
    this.deps.jobs.update(job.id, { feedback: accumulatedFeedback, iteration: nextIteration });
    this.emit(job.id, "agent-message", "orchestrator", `Post-deployment feedback received, iterating builder: ${postFeedback}`);

    let jobWorkspace: Awaited<ReturnType<typeof createJobWorkspace>> | null = null;
    try {
      jobWorkspace = await createJobWorkspace({
        targetRoot: workspace.rootPath,
        scratchDir: this.deps.scratchDir,
        jobId: job.id,
        blockName: plan.blockName,
        isGitRepo: workspace.isGitRepo,
      });
      this.deps.jobs.update(job.id, { workspaceDir: jobWorkspace.dir });

      this.transition(job.id, "post_feedback_building");
      const build = await buildBlock({
        workspaceDir: jobWorkspace.dir,
        repoProfile: workspace.repoProfile,
        blockSpec,
        plan,
        sourceArtifact: job.sourceArtifact as SourceArtifact,
        router: this.deps.router,
        feedback: accumulatedFeedback,
      });
      this.deps.jobs.addCost(job.id, build.costUsd);
      this.emit(job.id, "agent-message", "builder", `Post-feedback rebuild: ${build.summary}`, { output: build, artifacts: captureTraceArtifacts(jobWorkspace.dir, build.filesWritten) });
      if (build.filesMissing.length > 0) {
        this.emit(job.id, "agent-message", "builder", `Missing files after rebuild: ${build.filesMissing.join(", ")}`);
      }

      this.transition(job.id, "post_feedback_verifying");
      let verdict: VerdictReport;
      const verifyResult = await verifyBlock({
        workspaceDir: jobWorkspace.dir,
        repoProfile: workspace.repoProfile,
        plan,
        sourceArtifact: job.sourceArtifact as SourceArtifact,
        router: this.deps.router,
        outDir: join(this.deps.scratchDir, job.id, `post-feedback-verify-${nextIteration}`),
        iteration: nextIteration,
      });
      verdict = verifyResult.verdict;
      this.deps.jobs.update(job.id, { verdictJson: JSON.stringify(verdict) });
      this.deps.jobs.addCost(job.id, verifyResult.costUsd);
      this.emit(job.id, "agent-message", "verifier", verdict.pass ? "ÃƒÂ¢Ã…â€œÃ¢â‚¬Å“ Post-feedback verification passed" : `ÃƒÂ¢Ã…â€œÃ¢â‚¬â€ Issues found: ${verdict.issues.length} issue(s)`, { output: verdict });

      this.transition(job.id, "writing");
      const write = await writeResult({
        targetRoot: workspace.rootPath,
        workspace: jobWorkspace,
        jobId: job.id,
        blockName: plan.blockName,
        filesToCreate: plan.filesToCreate,
        filesToModify: plan.filesToModify,
        allowGenericPaths: workspace.repoProfile.projectType === "unknown",
      });
      this.deps.jobs.update(job.id, { writeResultJson: JSON.stringify(write), resultBranch: write.branchName });
      this.emit(job.id, "agent-message", "writer", write.mode === "git-commit" ? `Committed post-feedback changes to branch ${write.branchName} (${write.commitSha?.slice(0, 8)})` : `Written post-feedback changes to ${workspace.rootPath}`);

      this.transition(job.id, "deployed");
      this.emit(job.id, "agent-message", "orchestrator", "Post-feedback refinement complete and deployed. Ready for further testing.");
    } catch (err) {
      if (this.isCancellationRequested(job.id)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.emit(job.id, "error", null, message);
      this.transition(job.id, "failed", message);
      throw err;
    } finally {
      if (jobWorkspace) await removeJobWorkspace(workspace.rootPath, jobWorkspace).catch(() => {});
    }
  }

  private async runAemPostFeedbackRefinement(job: NonNullable<ReturnType<JobRepository["getJob"]>>, postFeedback: string, rootPath: string, isGitRepo: boolean, repoProfile: NonNullable<ReturnType<WorkspaceRepository["get"]>>["repoProfile"]): Promise<void> {
    if (!job.plan || !job.blockSpec || !job.sourceArtifact || !repoProfile) throw new Error(`AEM job ${job.id} is missing its plan, specification, source artifact, or repository profile`);
    const plan = job.plan as AemPlan;
    const componentSpec = job.blockSpec as AemComponentSpec;
    const accumulatedFeedback = job.feedback ? `${job.feedback}\n\n---\n\n${postFeedback}` : postFeedback;
    let jobWorkspace: Awaited<ReturnType<typeof createJobWorkspace>> | null = null;
    try {
      jobWorkspace = await createJobWorkspace({ targetRoot: rootPath, scratchDir: this.deps.scratchDir, jobId: job.id, blockName: plan.componentName, isGitRepo });
      this.deps.jobs.update(job.id, { workspaceDir: jobWorkspace.dir });
      this.transition(job.id, "post_feedback_building");
      const build = await buildAemComponent({ workspaceDir: jobWorkspace.dir, repoProfile, componentSpec, plan, sourceArtifact: job.sourceArtifact as SourceArtifact, router: this.deps.router, feedback: accumulatedFeedback });
      this.deps.jobs.addCost(job.id, build.costUsd);
      this.transition(job.id, "writing");
      const write = await writeResult({ targetRoot: rootPath, workspace: jobWorkspace, jobId: job.id, blockName: plan.componentName, filesToCreate: plan.filePlan.filesToCreate, filesToModify: plan.filePlan.filesToModify });
      this.deps.jobs.update(job.id, { writeResultJson: JSON.stringify(write), resultBranch: write.branchName });
      this.transition(job.id, "deployed");
    } catch (err) {
      if (this.isCancellationRequested(job.id)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.emit(job.id, "error", "aem-builder", message);
      this.transition(job.id, "failed", message);
      throw err;
    } finally {
      if (jobWorkspace) await removeJobWorkspace(rootPath, jobWorkspace).catch(() => {});
    }
  }

  private async ingest(jobId: string, sourceKind: "figma" | "image" | "pdf", sourceRef: string): Promise<SourceArtifact> {
    const outDir = join(this.deps.scratchDir, jobId, "source");
    switch (sourceKind) {
      case "figma": {
        if (!this.deps.figmaToken) throw new Error("No Figma token configured ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â set FIGMA_TOKEN to ingest Figma sources");
        return ingestFigma({ 
          url: sourceRef, 
          token: this.deps.figmaToken, 
          outDir,
          cache: this.deps.figmaCache,
          force: this.deps.forceRefresh,
        });
      }
      case "image":
        return ingestImage({ filePath: sourceRef, outDir });
      case "pdf":
        return ingestPdf({ filePath: sourceRef, outDir });
    }
  }

  private transition(jobId: string, status: JobStatus, errorMessage?: string): void {
    if (this.isCancellationRequested(jobId)) {
      throw new Error(`Job ${jobId} was cancelled`);
    }
    this.deps.jobs.setStatus(jobId, status, errorMessage);
    this.emit(jobId, "status", null, `Status ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢ ${status}`, { status });
  }

  private isCancellationRequested(jobId: string): boolean {
    return this.activeTasks.get(jobId)?.controller.signal.aborted ?? false;
  }

  /** Stop advancing a job and wait for its current stage and workspace cleanup to finish. */
  async cancelAndWait(jobId: string): Promise<void> {
    const active = this.activeTasks.get(jobId);
    if (active) {
      active.controller.abort();
      await active.promise.catch(() => {});
    }
    const job = this.deps.jobs.getJob(jobId);
    if (!job) return;
    if (!["done", "failed", "rejected", "code_only"].includes(job.status)) {
      this.deps.jobs.setStatus(jobId, "rejected", "Terminated by user before completion.");
      this.emit(jobId, "status", "user", "Job terminated by user.", { status: "rejected" });
    }
  }

  private track(jobId: string, run: () => Promise<void>): Promise<void> {
    const existing = this.activeTasks.get(jobId);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const task = Promise.resolve().then(run);
    const promise = task.finally(() => {
      if (this.activeTasks.get(jobId)?.promise === promise) this.activeTasks.delete(jobId);
    });
    this.activeTasks.set(jobId, { controller, promise });
    return promise;
  }

  private emit(jobId: string, type: "status" | "agent-message" | "tool-call" | "tool-result" | "error", agent: string | null, message: string, data?: unknown): void {
    const event: JobEvent = {
      jobId,
      ts: new Date().toISOString(),
      type,
      status: null,
      agent,
      message,
      data: data ?? null,
    };
    this.deps.jobs.appendEvent(event);
    const job = this.deps.jobs.getJob(jobId);
    if (job) {
      try {
        appendAgentTraceRecord({
          scratchDir: this.deps.scratchDir,
          job,
          repoProfile: this.deps.workspaces.get(job.workspaceId)?.repoProfile ?? null,
          models: this.traceModels,
          event,
        });
      } catch (err) {
        console.warn(`Could not append agent trace for job ${jobId}:`, err);
      }
    }
    this.deps.eventBus?.emit(jobId, event);
  }
}

/** Turns a failed VerdictReport into the feedback text the next Builder iteration is given ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â concrete issues, not the whole report. */
function summarizeVerdictForRebuild(verdict: VerdictReport): string {
  const lines = verdict.issues.map((issue) => `- [${issue.severity}/${issue.area}] ${issue.description}${issue.suggestedFix ? ` (fix: ${issue.suggestedFix})` : ""}`);
  return `The previous attempt failed verification. ${verdict.summary}\n\nIssues to fix:\n${lines.join("\n")}`;
}
