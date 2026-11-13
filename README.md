# Blocksmith

Multi-agent orchestration tool that converts a Figma design, a screenshot, or a BRD PDF into a
production-ready [Adobe Edge Delivery Services](https://www.aem.live/) block, wired for the
Universal Editor, and written straight into your project's source tree.

## How it works

1. **Point it at your EDS repo.** The Repo Cartographer agent reads the codebase once and builds a
   profile: existing blocks, design tokens, breakpoints, lint conventions, and Universal Editor
   config.
2. **Feed it a design.** Submit one or more sources — a Figma frame URL, an image, or a BRD PDF —
   as a batch. Jobs run in parallel, each in its own isolated workspace.
3. **Review the plan.** For each source, the agents decide whether to create a new block, extend
   an existing one, or add a variant — and present a plan before writing any code.
4. **Approve, and it builds.** Once approved, the Block Builder writes the block, wires it into the
   Universal Editor config, and the Verifier renders it headlessly, screenshots it, and critiques
   the result against the source design before handing it back.

See `packages/core/src/agents` for the agent definitions and `packages/core/src/orchestrator` for
the job state machine.

## Packages

- `packages/core` — agents, tools, orchestrator, persistence (no HTTP dependency)
- `packages/server` — Express API + SSE event stream
- `packages/web` — React UI

## Setup

```bash
npm install
cp .env.example .env   # fill in OPENROUTER_API_KEY and FIGMA_TOKEN
npm run dev:server      # http://localhost:4000
npm run dev:web         # http://localhost:5173
```
