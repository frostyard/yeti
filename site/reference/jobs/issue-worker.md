# issue-worker

> Implements approved issues as pull requests -- the job that turns plans into code.

| Property | Value |
|----------|-------|
| Type | Interval |
| Default interval | 5 minutes (`intervals.issueWorkerMs`) |
| Uses AI | Yes |
| Backend | Claude (configurable via `jobAi`) |
| Config key | `intervals.issueWorkerMs` |

## What it does

The issue-worker is the implementation engine. When an issue is approved with the `Refined` label, this job creates an isolated git worktree, runs Claude with the implementation plan, and opens a pull request with the resulting changes.

It handles both single-PR and multi-PR implementations, tracking phase progress across the lifecycle of complex issues.

## Trigger

- Issues with the `Refined` label (new implementation)
- Open issues with merged Yeti PRs but remaining phases (multi-PR continuation)

## Labels

| Label | Action |
|-------|--------|
| `Refined` | Requires (to start implementation) |
| `Refined` | Removes (after creating PR or if PR already exists) |
| `Ready` | Removes (when starting implementation) |
| `In Review` | Sets (after creating PR) |
| `Priority` | Propagates from issue to new PR |
| `Refined` | Sets (re-labels issue for next multi-PR phase after merge) |

## How it works

### Single-PR Implementation

1. Checks for an existing open PR for the issue (skips if found, removes `Refined`)
2. Removes the `Ready` label
3. Creates a git worktree on branch `yeti/issue-<number>-<hex4>`
4. Reads the `## Implementation Plan` comment from the issue
5. Runs Claude with the plan, issue body, and all comments
6. **Tree-diff guard:** Only pushes if there are both new commits AND actual tree differences vs. the default branch
7. Generates a PR description summarizing the changes
8. Creates PR titled `fix: resolve #<N> -- <issue title>` with body ending in `Closes #<N>`
9. Adds `In Review` label to the issue
10. Propagates `Priority` label to the PR if the issue has it
11. Removes `Refined` label

### Multi-PR Implementation

When the plan specifies multiple phases (using `### PR 1: ...`, `### PR 2: ...` format):

1. Determines the current phase based on how many PRs have already been merged
2. Posts a progress comment on the issue: `## Phase Progress`
3. Builds a phase-aware prompt -- Claude sees the full plan but is told to implement only the current phase
4. Creates PR titled `fix(#<N>): <phase title> (<M>/<total>)`
5. Intermediate PRs: body says `Part of #<N>`
6. Final PR: body says `Closes #<N>`

### Phase Continuation

After a multi-PR phase is merged:

1. The worker detects open issues with merged Yeti PRs but remaining phases
2. Confirms no open PR currently exists
3. Re-adds the `Refined` label to trigger the next phase
4. On the next poll cycle, the standard flow picks up the issue again

### Guards

- **Duplicate PR guard:** Uses `getOpenPRForIssue` with cache bypass (`fresh: true`) to prevent race conditions where a concurrent PR is invisible during the 60-second cache window
- **Tree-diff guard:** Checks both `hasNewCommits` (commit count) and `hasTreeDiff` (actual tree difference via `git diff --quiet`) before pushing. This prevents failures when commits produce no effective changes.

## Related jobs

- [issue-refiner](issue-refiner.md) -- Produces the plans this job implements
- [ci-fixer](ci-fixer.md) -- Fixes CI failures on the PRs this job creates
- [review-addresser](review-addresser.md) -- Addresses review comments on the PRs this job creates
- [auto-merger](auto-merger.md) -- Merges the PRs this job creates
