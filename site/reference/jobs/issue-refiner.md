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
4. Claude reads the relevant source files identified from the issue before planning (plans are grounded in actual code, not assumptions)
5. **Step 1 — Evaluate:** Claude evaluates whether the issue provides enough detail for a confident plan -- if underspecified, it outputs a `### Clarifying Questions` section with specific questions and instructs the user to respond as a comment
6. **Step 2 — Draft:** Claude drafts an initial implementation plan (text only, no code changes) for aspects that are sufficiently clear. For each file, the plan specifies what changes are needed and **why** (tied back to the issue requirement), along with:
    - **Implementation order** with rationale (e.g., types before consumers)
    - **Dependencies** between changes
    - **Risks and edge cases**
    - **Testing approach** (unit/integration/manual, with specific test file names)
7. **Step 3 — Self-critique:** Claude performs two rounds of structured self-critique against four dimensions: unverified assumptions (did it actually read the files it referenced?), scope discipline (is anything beyond what the issue requires?), ordering and dependencies (would a developer hit errors following the steps in order?), and risk honesty (are failure modes omitted to keep the plan tidy?). After each round, the plan is revised to address every weakness found.
8. **Step 4 — Final plan:** Claude outputs only the final revised plan, without intermediate drafts or critique notes
9. Claude chooses the narrowest reasonable interpretation of ambiguous issues and notes assumptions explicitly
10. Posts an `## Implementation Plan` comment on the issue
11. Transitions labels: removes `Needs Refinement`, adds `Needs Plan Review` or `Ready`
12. For `[ci-unrelated]` issues: also adds `Refined` to skip human approval

!!! note "Review loop re-entry"
    When `reviewLoop` is enabled, plan-reviewer can re-add `Needs Refinement` to trigger another refinement cycle. The issue-refiner handles this the same way as human-initiated re-refinement — it reads prior comments (including the review) and updates the plan.

### Refinement (Feedback Loop)

1. Detects unreacted human comments after the most recent plan
2. Feeds the existing plan and new feedback to Claude with instructions to:
    - Address each feedback item individually (never silently drop feedback; explain disagreements)
    - Preserve plan sections not affected by the feedback to avoid regressions
    - Stay within the original issue scope (out-of-scope suggestions go in a separate `### Out of Scope` section)
    - Output a `### Clarifying Questions` section if any feedback is ambiguous or contradictory, rather than guessing
    - Include a testing approach for verifying the changes
3. Claude produces an updated plan
4. **Edits the existing plan comment** in-place (does not create a new comment)
5. If Claude includes a `### Note` section, it is posted as a separate comment
6. Reacts with thumbsup to each addressed feedback comment
7. Re-adds `Needs Plan Review` or `Ready`

When no specific feedback is provided (e.g., a re-plan via label), the refiner asks Claude to re-evaluate the plan for missing files, edge cases, implementation order, and testing sufficiency.

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
