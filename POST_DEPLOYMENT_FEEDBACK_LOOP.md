# Post-Deployment Feedback Loop

## Overview

After code is created and deployed to the codebase, users can test the implementation and provide feedback for iterative refinement. The agent system retains knowledge of all generated artifacts (BlockSpec, Plan, design source) and can rebuild the code to match feedback without losing context.

## New Job Statuses

Three new statuses support the post-deployment feedback loop:

- **`deployed`**: Code has been written to the target repository and is ready for testing. User can now provide post-deployment feedback via the POST `/jobs/{jobId}/post-feedback` endpoint.
- **`post_feedback_building`**: Agent is rebuilding the code based on user feedback from a deployed version.
- **`post_feedback_verifying`**: Agent is verifying the iterative changes to ensure they meet quality criteria.

## Job Status Lifecycle with Post-Deployment Feedback

```
created → ingesting → analyzing → planning → awaiting_approval
    ↓
    approve()
    ↓
building ↔ verifying (loop up to 3 times)
    ↓
writing
    ↓
deployed ← (user tests code, discovers issues)
    ↓
    refineAfterDeployment(feedback) [NEW]
    ↓
post_feedback_building ↔ post_feedback_verifying
    ↓
writing (commit iterative changes)
    ↓
deployed (ready for further testing)
    ↓
    (repeat refinement loop, or) → done (terminal)
```

## API Endpoint

### POST `/api/jobs/{jobId}/post-feedback`

Submit post-deployment feedback for code that has already been deployed.

**Request Body:**
```json
{
  "feedback": "The button color should be blue instead of red. Also, fix the alignment of the text below."
}
```

**Response:**
- `202 Accepted` with `{ ok: true }` — feedback accepted, refinement job queued
- `404 Not Found` — job does not exist
- `409 Conflict` — job is not in `deployed` or `done` status
- `400 Bad Request` — feedback field is missing or empty

**Progress Tracking:**
The client monitors refinement progress via the job's Server-Sent Events stream (`GET /api/jobs/{jobId}/events`):
- Initial `post_feedback_building` status
- Agent messages as code is being rebuilt
- Optional `post_feedback_verifying` status with verification results
- Final status transition back to `deployed` on success, or `failed` on error

## Agent Context Retention

The agent system automatically retains knowledge of:

1. **Design source**: Original ingested artifact (Figma screenshot, image, or PDF)
2. **Block specification**: Semantic structure, accessibility requirements, field definitions
3. **Reuse decision**: Whether the block is new or extending an existing block
4. **Plan**: File structure, which files to create/modify, targeted token names
5. **Previously built code**: Available in the isolated job workspace for reference

This context flows into the Builder when processing post-deployment feedback, allowing the agent to:
- Understand the full design intent, not just fix syntax issues
- Maintain consistency with existing patterns in the repository
- Apply Adobe EDS conventions and field collapse rules
- Implement iterative refinements that align with the original design

## Workflow Example

### Initial Creation → Deployment

1. User provides Figma frame or screenshot
2. System ingests design → interprets BlockSpec → analyzes reuse → plans changes
3. User approves the plan
4. Agent builds code, verifies, and deploys to branch
5. Job status transitions to `deployed`

### Post-Deployment Testing & Refinement

6. User tests the deployed code:
   - Visual inspection of the block
   - Behavior testing (interactions, responsiveness)
   - Accessibility validation
   - Integration with existing page patterns
7. User discovers issues: "Button styling doesn't match design system" or "Text truncates on mobile"
8. User submits feedback via POST `/api/jobs/{jobId}/post-feedback`:
   ```json
   { "feedback": "Button should use primary-action color token. Text should wrap instead of truncate." }
   ```
9. Agent rebuilds code with feedback:
   - Reads the feedback and existing job artifacts
   - Generates updated code matching both original design and feedback
   - Verifies the updated code
   - Commits iterative changes to the same branch
   - Job returns to `deployed` status
10. User can continue testing and submit more feedback, repeating steps 7-9 as needed

## Implementation Details

### JobRunner.refineAfterDeployment(jobId, feedback)

New public method on `JobRunner` class:

- **Accepts**: Job ID and post-deployment feedback text
- **Preconditions**: Job must be in `deployed` or `done` status with valid plan and blockSpec
- **Execution**:
  1. Accumulates feedback into the job record (like rejection, but separate flow)
  2. Transitions to `post_feedback_building`
  3. Creates an isolated workspace copy of target repo with deployed code
  4. Calls `buildBlock()` with accumulated feedback
  5. Transitions to `post_feedback_verifying`
  6. Calls `verifyBlock()` to validate changes
  7. Writes results (commits to same branch, no branching conflict)
  8. Transitions back to `deployed` for further testing
- **Error Handling**: Failures surface as job events/status, not HTTP errors (202 Accepted fired before async work)
- **Concurrency**: Uses same `buildLimit` as approval pipeline to prevent resource exhaustion

### Database & Job Tracking

The existing `Job` record structure already supports iteration tracking:

- `feedback`: Accumulates all feedback (initial rejection + post-deployment feedback) separated by "---"
- `iteration`: Incremented on each rejection or post-deployment refinement
- `plan`, `blockSpec`, `sourceArtifact`: Retained and reused across iterations
- `writeResult`: Updated with each commit, including branch name and commit SHA

No schema migration required.

## Builder System Prompt

The Builder agent system prompt includes guidance on handling post-deployment feedback:

> If feedback from a deployed version is provided, it represents user observations from real testing. Prioritize user feedback and fix the issues raised, but maintain consistency with the original design intent and Adobe EDS conventions.

## Related Files

- **New/Modified**:
  - `packages/core/src/schemas/job.ts`: Added `deployed`, `post_feedback_building`, `post_feedback_verifying` statuses
  - `packages/core/src/orchestrator/runner.ts`: Added `refineAfterDeployment()` and `runPostFeedbackRefinement()` methods
  - `packages/server/src/routes/jobs.ts`: Added POST `/jobs/{jobId}/post-feedback` endpoint

- **Existing (used by post-deployment flow)**:
  - `packages/core/src/agents/builder.ts`: Already supports feedback parameter
  - `packages/core/src/agents/verifier.ts`: Already supports feedback in verification context
