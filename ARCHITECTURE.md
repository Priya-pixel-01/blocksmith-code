# Blocksmith Architecture

## Overview

Blocksmith is a multi-agent orchestration tool that converts design sources (Figma frames, screenshots, or PDF BRDs) into production-ready Adobe Edge Delivery Services (AEM) blocks. The system analyzes existing codebases, interprets designs, plans changes, builds code, and verifies output with iterative refinement cycles.

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Web Frontend (React)                      │
│                    (Vite, TypeScript, REST API)                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   Express API Server                             │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Routes: /jobs, /batch, /uploads, /workspace              │   │
│  │ SSE Event Streaming for real-time job progress           │   │
│  │ Multipart file upload handling                           │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Core Engine (@blocksmith/core)               │
│                    (TypeScript, No HTTP deps)                    │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Orchestrator & Job Runner                                │   │
│  │ • State machine: created → ingesting → analyzing →        │   │
│  │                 planning → awaiting_approval → building   │   │
│  │                 ↔ verifying → writing → deployed          │   │
│  │ • Event bus for status tracking                           │   │
│  │ • Concurrency control (build/verify pipelines)            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                           ▼                                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Multi-Agent System                                       │   │
│  │ ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │   │
│  │ │  Interpreter │  │  Planner     │  │  Builder     │    │   │
│  │ │ (Design→Spec)│  │ (Plan files) │  │ (Write code) │    │   │
│  │ └──────────────┘  └──────────────┘  └──────────────┘    │   │
│  │ ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │   │
│  │ │  Cartographer│  │  Reuse       │  │  Verifier    │    │   │
│  │ │ (Repo scan)  │  │ (New vs Ext) │  │ (Lint/Test)  │    │   │
│  │ └──────────────┘  └──────────────┘  └──────────────┘    │   │
│  └──────────────────────────────────────────────────────────┘   │
│                           ▼                                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Core Subsystems                                          │   │
│  │                                                          │   │
│  │ Ingestion Pipeline:                                      │   │
│  │  • Figma (tree extraction + rendering)                   │   │
│  │  • Image (direct ingestion)                              │   │
│  │  • PDF (page rasterization + text extraction)            │   │
│  │                                                          │   │
│  │ LLM Router:                                              │   │
│  │  • OpenRouter integration                                │   │
│  │  • Multi-model support                                   │   │
│  │  • Structured output (Zod validation)                    │   │
│  │                                                          │   │
│  │ Workspace Isolation:                                     │   │
│  │  • Per-job isolated filesystem                           │   │
│  │  • Git clone of target repo                              │   │
│  │  • Safe experimentation without side effects             │   │
│  │                                                          │   │
│  │ Verification & Testing:                                  │   │
│  │  • Headless rendering (Playwright)                       │   │
│  │  • Axe accessibility scanning                            │   │
│  │  • Linting (ESLint)                                      │   │
│  │  • Screenshot comparison against source                  │   │
│  │                                                          │   │
│  │ Agent Tools:                                             │   │
│  │  • FileSystem (read/write within plan scope)             │   │
│  │  • Block utilities (existing block introspection)        │   │
│  │  • Sandbox evaluation (safe expression execution)        │   │
│  └──────────────────────────────────────────────────────────┘   │
│                           ▼                                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Persistence Layer                                        │   │
│  │ • SQLite (better-sqlite3)                                │   │
│  │ • Drizzle ORM with migrations                            │   │
│  │ • JobRepository, WorkspaceRepository, FigmaCacheRepo     │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    External Services                             │
│  • OpenRouter API (LLM inference)                               │
│  • Figma API (design tree + rendering)                          │
│  • Target Git Repositories (source & write locations)           │
│  • Headless Chromium (rendering & accessibility)                │
└─────────────────────────────────────────────────────────────────┘
```

## Core Layers

### 1. **Presentation Layer**
- **Technology**: React 18 + TypeScript + Vite
- **Location**: `packages/web/`
- **Responsibility**: 
  - Job board UI for tracking batch submissions
  - Job detail view with plan review and approval interface
  - New batch creation with file uploads
  - Real-time progress updates via SSE
  - Markdown rendering for plan narratives and feedback

### 2. **API Layer**
- **Technology**: Express.js v5 + TypeScript
- **Location**: `packages/server/src/routes/`
- **Endpoints**:
  - `POST /api/jobs` - Create new job
  - `POST /api/batch` - Submit batch of sources
  - `GET /api/jobs/{jobId}` - Retrieve job details
  - `GET /api/jobs/{jobId}/events` - SSE event stream
  - `POST /api/jobs/{jobId}/approve` - User approval
  - `POST /api/jobs/{jobId}/reject` - User rejection with feedback
  - `POST /api/jobs/{jobId}/post-feedback` - Post-deployment refinement
  - `POST /api/uploads` - File upload handler
  - `GET /api/workspace` - Workspace metadata
- **Features**:
  - Multipart file upload (Figma URLs, images, PDFs)
  - CORS-enabled
  - Server-Sent Events (SSE) for real-time job progress
  - Concurrency control for parallel job execution

### 3. **Orchestration & State Machine**
- **Technology**: Node.js EventEmitter, p-limit for concurrency
- **Location**: `packages/core/src/orchestrator/`
- **Key File**: `runner.ts`
- **Job Status Lifecycle**:
  ```
  created 
    ↓
  ingesting (source → image)
    ↓
  analyzing (extract BlockSpec from design)
    ↓
  planning (determine files to create/modify)
    ↓
  awaiting_approval (human review)
    ↓
  [User approval or rejection]
    ↓
  building ↔ verifying (up to 3 iterations)
    ↓
  writing (apply changes to target repo)
    ↓
  deployed (ready for testing)
    ↓
  [Optional: post-deployment feedback loop]
    ↓
  post_feedback_building ↔ post_feedback_verifying
    ↓
  done (terminal)
  ```
- **Build-Verify Loop**:
  - Builder writes code to isolated workspace
  - Verifier lints, renders, screenshots, scans accessibility
  - If issues found: feedback → Builder attempts fix (max 3 times)
  - Final state (clean or attempted) written to target repo

### 4. **Multi-Agent System**
- **Location**: `packages/core/src/agents/`
- **LLM Backend**: OpenRouter (multi-model, structured output via Zod)

#### Agent Responsibilities:

**Cartographer** (`cartographer/`)
- Scans target repository once on first job
- Builds RepoProfile containing:
  - Existing blocks and their locations
  - Design token definitions and naming conventions
  - CSS breakpoints and media queries
  - Universal Editor config and field patterns
  - Lint rules and code style conventions
- Enables all downstream agents to respect repo specifics

**Interpreter** (`interpreter.ts`)
- Input: Design source (rendered image) + RepoProfile
- Output: BlockSpec (semantic structure)
- Responsible for:
  - Translating visual design to semantic block definition
  - Proposing block name (kebab-case)
  - Defining Universal Editor fields (text, richtext, reference, select, boolean, number, container)
  - Documenting field collapse rules (Adobe reserved suffixes: Alt, Text, Title, Type, MimeType)
  - Identifying design tokens and new token needs
  - Raising open questions for human clarification

**Reuse Agent** (`reuse.ts`)
- Input: BlockSpec + RepoProfile + existing blocks
- Output: ReuseDecision (create new vs. extend existing block)
- Decision logic:
  - Analyze existing blocks for compatibility
  - Determine if new block or variant of existing block
  - Assess modification risk if extending

**Planner** (`planner.ts`)
- Input: BlockSpec + ReuseDecision + RepoProfile
- Output: Plan (file manifest + narrative)
- Deterministic file computation:
  - Which files to create (new block structure)
  - Which files to modify (Universal Editor config, design tokens)
  - File paths based on repo's fragment discovery (e.g., `blocks/<name>/_<name>.json`)
- Generates human-readable summary with:
  - What will be built and why
  - Verification criteria
  - Risk callouts
  - Names for new design tokens

**Builder** (`builder.ts`)
- Input: Plan + BlockSpec + isolated workspace clone of target repo
- Output: Written block code (JavaScript, HTML, CSS)
- Process:
  - Creates block directory structure
  - Generates `block.js` (decorate function, moveInstrumentation for Universal Editor)
  - Creates `_<name>.json` (block metadata)
  - Generates CSS with proper token references
  - Matches repo conventions (quote style, imports, helper usage)
  - Only writes files listed in approved plan
- Tools available:
  - `read_block()` - inspect existing blocks for pattern matching
  - `read_file()` - access repo files for conventions
  - `write_file()` - write within plan scope only
  - Lint tool integration

**Verifier** (`verifier.ts`)
- Input: Written block in isolated workspace
- Output: VerdictReport (pass/fail with issue details)
- Verification steps:
  1. **Linting**: ESLint validation
  2. **Rendering**: Headless Chromium renders block with sample data
  3. **Screenshots**: Captures rendered output
  4. **A11y Scanning**: Axe accessibility audit
  5. **Comparison**: Screenshots vs. source design (visual fidelity check)
- Issues trigger feedback loop:
  - Verifier summarizes failures
  - Builder receives issues, attempts fix
  - Loop repeats up to 3 times
- If MAX_BUILD_VERIFY_ITERATIONS exceeded:
  - Last attempt written to target repo anyway
  - Issues surfaced to user, not silently hidden

### 5. **Ingestion Pipeline**
- **Location**: `packages/core/src/ingest/`
- **Supported Formats**:
  - **Figma**: Tree extraction (layout, fills, typography, text) + screenshot
  - **Image**: Direct ingestion (PNG, JPG)
  - **PDF**: Page rasterization + text extraction via pdfjs-dist
- **Output**: SourceArtifact (image + optional extracted text)

### 6. **Workspace Isolation**
- **Location**: `packages/core/src/workspace/`
- **Purpose**: Sandboxed environment per job
- **Implementation**:
  - Per-job directory in scratchDir
  - `git clone` of target repository
  - All build/verify operations run in this clone
  - Write operation applies final state to real repo
  - Clean up on job completion
- **Enables**:
  - Safe experimentation without side effects
  - Concurrent jobs without cross-contamination
  - Easy rollback (isolated clone deleted)

### 7. **Persistence Layer**
- **Technology**: SQLite + Drizzle ORM
- **Location**: `packages/core/src/db/`
- **Schema**:
  - **Jobs**: Status, source details, BlockSpec, Plan, VerdictReport, timestamps
  - **Workspaces**: Isolation metadata per job
  - **FigmaCache**: Cached Figma tree extraction and rendering (avoid repeated API calls)
- **Repositories**:
  - JobRepository: Create, update, retrieve jobs
  - WorkspaceRepository: Manage isolated job workspaces
  - FigmaCacheRepository: Cache Figma data

### 8. **Schemas & Type Safety**
- **Location**: `packages/core/src/schemas/`
- **Key Types** (validated with Zod):
  - `SourceArtifact`: Ingested design (source image + text)
  - `BlockSpec`: Semantic block definition (name, fields, tokens, open questions)
  - `Plan`: File manifest + narrative (summary, verification criteria, risks)
  - `VerdictReport`: Verification results (pass/fail, issues, screenshots)
  - `RepoProfile`: Target repo metadata (blocks, tokens, breakpoints, conventions)
  - `Job`: Overall job state and events
  - `ReuseDecision`: New vs. extend decision

## Data Flow

### End-to-End Job Execution

```
1. User Submission
   ├─ Upload Figma URL / Image / PDF
   └─ Create batch with source references

2. Ingestion (Parallel per source)
   ├─ Ingest Figma / Image / PDF → SourceArtifact
   └─ Persist ingestion results, update status: ingesting → analyzing

3. Analysis (Sequential per job)
   ├─ Cartographer: Scan target repo → RepoProfile (cached)
   ├─ Interpreter: Design + Repo → BlockSpec
   ├─ Reuse: BlockSpec + Existing blocks → ReuseDecision
   ├─ Planner: BlockSpec + Decision + Repo → Plan
   └─ Update status: analyzing → planning → awaiting_approval

4. User Review & Approval
   ├─ UI displays Plan (summary, files, risks)
   ├─ User reviews and approves or rejects with feedback
   └─ On approval: status → building

5. Build-Verify Loop (Concurrent, up to 3 iterations)
   ├─ Iteration N:
   │  ├─ Create isolated workspace (git clone)
   │  ├─ Builder: Write code per approved plan
   │  ├─ Verifier: Lint, render, screenshot, scan a11y
   │  ├─ If pass: status → writing
   │  └─ If fail (N < 3): Feedback to Builder, loop
   └─ If fail (N = 3): Write last attempt anyway

6. Writing (Apply to Real Repo)
   ├─ Merge isolated workspace changes into target repo
   ├─ Commit with generated message
   └─ Update status: writing → deployed

7. Optional: Post-Deployment Feedback Loop
   ├─ User tests deployed code
   ├─ Submits feedback via POST /api/jobs/{jobId}/post-feedback
   ├─ Agent retains design context + original BlockSpec + Plan
   ├─ Runs build ↔ verify again with feedback as guidance
   ├─ Writes iterative changes to target repo
   └─ Job remains deployable for further refinement

8. Terminal States
   ├─ done: Fully completed (no further refinement expected)
   ├─ failed: Unrecoverable error during job execution
   └─ rejected: User explicitly rejected during planning phase
```

### Event Flow (Real-Time Updates)

- **Event Bus**: Node.js EventEmitter within orchestrator
- **Subscribers**: SSE route (`GET /api/jobs/{jobId}/events`)
- **Events**:
  - Status transitions (ingesting, analyzing, building, etc.)
  - Agent messages (reasoning, decisions, issues)
  - Verification results (pass/fail details)
  - Error notifications with context
- **Client**: React UI subscribes to SSE stream, updates UI in real-time

## Key Design Patterns

### 1. **Deterministic File Planning**
- Planner computes file changes based on repo facts (glob discovery), not LLM guesses
- Enables Plan review with confidence: files listed are exactly what will be touched
- Builder restricted to approved file set via tool layer

### 2. **Graceful Degradation**
- Even if build-verify loop exhausts max iterations, final attempt is written to repo
- Issues are surfaced (not hidden), enabling human review and post-deployment refinement

### 3. **Context Retention Across Feedback Loops**
- Original SourceArtifact, BlockSpec, Plan, and previously built code all retained
- Post-deployment feedback leverages full context for coherent, design-aware refinements
- Prevents "one-off fixes" that lose architectural intent

### 4. **Isolated Workspaces**
- Per-job git clone prevents side effects
- Concurrent jobs can run safely in parallel
- Rollback is automatic (cleanup removes workspace)
- Real repo touched only by final write operation

### 5. **Structured Output (Zod Validation)**
- All agent outputs validated against schemas
- LLM output structured via Zod, preventing invalid BlockSpec/Plan/VerdictReport
- Type safety throughout: TypeScript + Zod

## Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Frontend** | React 18, TypeScript, Vite | Web UI |
| **API** | Express.js v5, TypeScript | REST + SSE |
| **Core Engine** | Node.js, TypeScript | Orchestration, agents |
| **LLM** | OpenRouter (multi-model), ai SDK | Structured agent inference |
| **Persistence** | SQLite, Drizzle ORM | Job state & metadata |
| **Workspace Isolation** | simple-git, Node.js fs | Per-job git clone |
| **Rendering & A11y** | Playwright, Axe, Headless Chromium | Verification |
| **Design Integration** | Figma API, pdfjs-dist, Sharp | Source ingestion |
| **Code Quality** | ESLint | Build verification |
| **Concurrency** | p-limit | Parallel job/build-verify pipelines |

## Module Dependencies

```
web/
  ├─ api.ts (HTTP client to server)
  └─ (No direct dependency on core)

server/
  ├─ app.ts (Express setup)
  ├─ routes/ (HTTP endpoints)
  └─ @blocksmith/core (job runner, repositories)

core/
  ├─ orchestrator/runner.ts (state machine, entry point)
  ├─ agents/ (interpreter, planner, builder, verifier, reuse, cartographer)
  ├─ ingest/ (figma, image, pdf)
  ├─ workspace/ (isolation, setup, cleanup)
  ├─ verify/ (rendering, a11y scanning, linting)
  ├─ db/ (repositories, schema)
  ├─ llm/ (model router, config)
  ├─ tools/ (fs, blocks, lint, sandbox)
  └─ schemas/ (BlockSpec, Plan, VerdictReport, etc.)
```

## Deployment Considerations

1. **Concurrency**: `buildConcurrency` parameter limits concurrent build-verify pipelines (default 2)
   - Each pipeline spins up Headless Chromium for rendering
   - Resource-constrained environments should lower this
   
2. **Scratch Directory**: Requires disk space for:
   - Ingested images (rasterized PDFs, Figma screenshots)
   - Per-job isolated workspaces (git clones of target repos)
   - Verification screenshots and artifacts
   
3. **Environment Variables**:
   - `OPENROUTER_API_KEY`: LLM inference
   - `FIGMA_TOKEN`: Figma API access (required for Figma sources)
   
4. **External Dependencies**:
   - Headless Chromium (Playwright): Automatically downloaded
   - Axe accessibility library: Bundled
   - SQLite: Embedded via better-sqlite3

## Extensibility Points

1. **New Ingestion Sources**: Add handler in `packages/core/src/ingest/`
2. **New Verification Checks**: Extend `verifier.ts` with additional tools
3. **Model Switching**: Update `llm/router.ts` to add new LLM providers
4. **Custom Tooling**: Extend agent tools in `packages/core/src/tools/`
5. **Workspace Strategies**: Modify isolation strategy in `workspace/`
6. **Post-Deployment Feedback**: Leverage existing framework (already designed in)

## Security & Isolation

- **Agent Tool Restrictions**: Builder can only write files listed in approved Plan
- **Workspace Isolation**: Each job runs in separate git clone, no shared state
- **LLM Output Validation**: All agent outputs validated with Zod schemas
- **No Arbitrary Code Execution**: Sandbox tool (`sandbox.ts`) restricts eval scope
- **Credentials**: Secrets (API keys) stored in environment, never in code or database
