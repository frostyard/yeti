# issue-refiner

> Generates and refines implementation plans for issues, turning cold requirements into warm, actionable blueprints.

| Property | Value |
|----------|-------|
| Type | Interval |
| Default interval | 5 minutes (`intervals.issueRefinerMs`) |
| Uses AI | Yes |
| Backend | Claude (configurable via `jobAi`) |
| Config key | `intervals.issueRefinerMs` |

## What it does

The issue-refiner is the planning engine at the heart of Yeti's workflow. It reads GitHub issues and produces detailed implementation plans -- which files to change, what the changes should be, risks, edge cases, and a suggested implementation order.

When feedback arrives on an existing plan, the refiner updates the plan in-place rather than posting a new comment, keeping the issue thread clean. It also handles follow-up questions on issues that already have open PRs.

## Trigger

The refiner processes an issue when any of these conditions are met:

1. **New plan needed:** Issue has the `Needs Refinement` label and no existing plan comment
2. **Re-plan requested:** Issue has the `Needs Refinement` label and an existing plan (produces a fresh plan)
3. **Feedback to address:** Issue has an existing plan with unreacted human comments posted after it
4. **Auto-plan exemptions:** `[ci-unrelated]` or `[yeti-error]` issues (with triage report) are processed without requiring the `Needs Refinement` label
5. **Follow-up questions:** Issues with open PRs and unreacted human comments after the plan

## Labels

| Label | Action |
|-------|--------|
| `Needs Refinement` | Requires (for new plans on regular issues) |
| `Needs Refinement` | Removes (after posting plan) |
| `Needs Plan Review` | Sets (if plan-reviewer is enabled) |
| `Ready` | Sets (if plan-reviewer is disabled) |
| `Ready` | Removes (when new feedback arrives) |
| `Refined` | Sets (auto-refines `[ci-unrelated]` issues) |

## How it works

### New Plan

1. Creates an isolated git worktree for the repository
2. Reads the issue body, all comments, and any referenced images
3. Instructs Claude to read `yeti/OVERVIEW.md` and linked docs for codebase context
4. Claude produces the plan (text only, no code changes)
5. Posts an `## Implementation Plan` comment on the issue
6. Transitions labels: removes `Needs Refinement`, adds `Needs Plan Review` or `Ready`
7. For `[ci-unrelated]` issues: also adds `Refined` to skip human approval

### Refinement (Feedback Loop)

1. Detects unreacted human comments after the most recent plan
2. Feeds the existing plan and new feedback to Claude
3. Claude produces an updated plan
4. **Edits the existing plan comment** in-place (does not create a new comment)
5. If Claude includes a `### Note` section, it is posted as a separate comment
6. Reacts with thumbsup to each addressed feedback comment
7. Re-adds `Needs Plan Review` or `Ready`

### Follow-Up Response

When an issue has an open PR but new human comments appear:

1. Detects unreacted comments on issues with open Yeti PRs
2. Feeds the existing plan, PR number, and follow-up comments to Claude
3. Claude responds to questions and clarifications (no new plan produced)
4. Posts the response as a comment
5. Reacts with thumbsup to each addressed comment

### Multi-PR Plans

The refiner instructs Claude to prefer single PRs but supports multi-PR plans for genuinely large changes. Multi-PR plans use a structured format (`### PR 1: ...`, `### PR 2: ...`) that the [issue-worker](issue-worker.md) parses for phased implementation.

## Related jobs

- [plan-reviewer](plan-reviewer.md) -- Reviews plans produced by the refiner
- [issue-worker](issue-worker.md) -- Implements approved plans
- [issue-auditor](issue-auditor.md) -- Detects issues needing refinement
- [triage-yeti-errors](triage-yeti-errors.md) -- Must triage `[yeti-error]` issues before the refiner processes them
