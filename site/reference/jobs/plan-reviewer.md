# plan-reviewer

> Adversarial review of implementation plans -- a second pair of eyes before a human decides.

| Property | Value |
|----------|-------|
| Type | Interval |
| Default interval | 10 minutes (`intervals.planReviewerMs`) |
| Uses AI | Yes |
| Backend | Configurable (defaults to Claude, commonly set to Copilot for a different perspective) |
| Config key | `intervals.planReviewerMs` |

## What it does

The plan-reviewer provides an adversarial critique of implementation plans. It reads the plan and the original issue, then posts a review highlighting gaps, risks, edge cases, missing test coverage, and over-engineering concerns.

By default, the review is written **for the human**, not for automatic AI refinement. When plan-reviewer is enabled, the workflow becomes human-in-the-loop: issue-refiner produces a plan, plan-reviewer critiques it, both land on the issue as comments with the `Ready` label, and a human reads both before deciding to approve or request changes.

When `reviewLoop` is enabled in config, the reviewer can also send plans back to the issue-refiner for automatic re-refinement. See [Review Loop](#review-loop) below.

## Trigger

Issues with the `Needs Plan Review` label that have an unreviewed plan comment (no thumbsup reaction from Yeti on the plan comment).

## Labels

| Label | Action |
|-------|--------|
| `Needs Plan Review` | Requires |
| `Needs Plan Review` | Removes (after posting review) |
| `Ready` | Sets (after posting review, or when max rounds reached) |
| `Needs Refinement` | Sets (review loop only, when verdict is "needs revision" and under max rounds) |

## How it works

1. Scans open issues for the `Needs Plan Review` label
2. Finds the most recent `## Implementation Plan` comment (posted by Yeti)
3. Checks if the plan has already been reviewed (thumbsup reaction from Yeti)
4. Creates an isolated git worktree for the repository
5. Builds a prompt with the issue details and the plan
6. Runs the AI (Claude or Copilot, based on `jobAi` config) to critique the plan
7. Posts a `## Plan Review` comment on the issue
8. Reacts with thumbsup to the plan comment (marks it as reviewed)
9. Removes `Needs Plan Review`, adds `Ready` (default mode) **or** follows review loop logic (see below)

### Review Loop

When `reviewLoop: true` is set in config, the plan-reviewer asks the AI to end its review with a verdict line (`VERDICT: APPROVED` or `VERDICT: NEEDS REVISION`). The verdict line is stripped from the posted comment.

- **APPROVED:** Removes `Needs Plan Review`, adds `Ready` (same as default mode).
- **NEEDS REVISION:** Checks how many review rounds have completed. If under `maxPlanRounds`, removes `Needs Plan Review` and adds `Needs Refinement` — sending the issue back to issue-refiner for another cycle. If at the limit, posts a warning comment and adds `Ready` so a human can take over.
- **No verdict found:** Defaults to "needs revision" behavior.

The round count is based on existing `## Plan Review` comments posted by Yeti on the issue.

### Review Focus Areas

The reviewer is instructed to look for:

- Missing edge cases or error handling
- Files that should be modified but are not mentioned
- Incorrect assumptions about the codebase
- Risks that are not acknowledged
- Over-engineering or unnecessary complexity
- Missing test coverage

If the plan is solid, the review says so briefly.

### Backend Configuration

A common pattern is to route the plan-reviewer through a different AI backend than the refiner that wrote the plan. This provides genuine diversity of perspective:

```json
{
  "jobAi": {
    "plan-reviewer": { "backend": "copilot" }
  }
}
```

When the backend is set to `copilot`, the job's work is queued through the Copilot worker pool with its own concurrency limits.

## Related jobs

- [issue-refiner](issue-refiner.md) -- Produces the plans that this job reviews
- [issue-worker](issue-worker.md) -- Implements plans after human approval
