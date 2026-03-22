# ci-fixer

> Watches for failing CI and merge conflicts on Yeti PRs, then fixes them -- keeping the pipeline clear like a snowplow on a frozen highway.

| Property | Value |
|----------|-------|
| Type | Interval |
| Default interval | 10 minutes (`intervals.ciFixerMs`) |
| Uses AI | Yes |
| Backend | Claude (configurable via `jobAi`) |
| Config key | `intervals.ciFixerMs` |

## What it does

The ci-fixer monitors all open Yeti PRs for problems: merge conflicts, failing CI checks, and cancelled workflows. It uses a two-phase approach -- first identifying all work across all PRs, then processing it -- to prevent race conditions with concurrent GitHub API calls.

When failures are detected, the ci-fixer classifies them as either related to the PR's changes (and fixes them) or unrelated (flakey tests, runner issues), handling each case differently.

## Trigger

Open PRs with any of:

- Merge conflicts (`CONFLICTING` mergeable state)
- Failing CI checks
- Cancelled or startup-failure check runs

## Labels

| Label | Action |
|-------|--------|
| `Priority` | Respected (priority items are queued first) |

The ci-fixer does not set or remove labels directly. It operates on PRs and lets other jobs manage issue labels.

## How it works

### Phase 1: Identify All Work

The ci-fixer scans every open PR across all repos and classifies each into one of four work types:

| Kind | Condition | Action |
|------|-----------|--------|
| `conflict` | PR has `CONFLICTING` mergeable state | Merge base branch, resolve conflicts |
| `rerun` | Check is `CANCELLED` or `STARTUP_FAILURE` | Re-run the GitHub Actions workflow |
| `unrelated` | CI failure classified as unrelated to PR changes | File issue, revert previous fixes, merge base |
| `fix` | CI failure classified as related to PR changes | Use Claude to fix the code |

### Phase 2a: Handle Unrelated Failures

For failures classified as unrelated (grouped by repository):

1. **File a `[ci-unrelated]` issue** -- Creates or updates a tracking issue with the failure fingerprint, affected PR, and abbreviated logs
2. **Revert previous fix attempts** -- If Yeti previously tried to fix an unrelated failure on this PR, those commits are reverted
3. **Merge base branch** -- Brings the PR branch up to date, which often resolves pre-existing failures

### Phase 2b: Handle Remaining Items

Processed concurrently:

**Merge Conflicts:**

1. Creates a worktree from the PR branch
2. Attempts `git merge origin/<base-branch>`
3. If clean merge: pushes directly
4. If conflicts: runs Claude to resolve each conflicted file, remove conflict markers, stage, and commit
5. Updates PR description after resolution

**Re-runs:**

1. Extracts the workflow run ID from the check link
2. Calls `gh run rerun` to restart the workflow

**CI Fixes (Related Failures):**

1. Creates a worktree from the PR branch
2. Feeds the failure logs to Claude
3. Claude analyzes the failure and makes code changes
4. Pushes changes and updates PR description

### CI Failure Classification

For non-trivial failures, the ci-fixer uses Claude to classify whether the failure is related to the PR's changes. The classifier receives:

- The PR title and branch name
- Files changed in the PR
- The CI failure log

It returns a JSON response:

```json
{
  "related": true,
  "fingerprint": "test:auth-timeout",
  "reason": "Test failure in auth module matches files changed in PR"
}
```

Classification rules (safe defaults -- when in doubt, classify as related):

- Failures in files the PR modified: **related**
- Test failures testing code the PR changed: **related**
- Flakey tests (timeouts, race conditions): **unrelated**
- CI runner issues (disk space, network): **unrelated**
- Pre-existing failures on the base branch: **unrelated**

### Error Handling on ci-unrelated Fix PRs

PRs that fix `[ci-unrelated]` issues (`pr.title.includes("[ci-unrelated]")`) skip the classification step entirely -- their failures are always treated as related. If the fix itself errors out, the error is posted as a comment on the PR rather than creating another error issue.

## Related jobs

- [issue-worker](issue-worker.md) -- Creates the PRs that ci-fixer monitors
- [auto-merger](auto-merger.md) -- Merges PRs after ci-fixer resolves their issues
- [review-addresser](review-addresser.md) -- Also operates on open PRs
