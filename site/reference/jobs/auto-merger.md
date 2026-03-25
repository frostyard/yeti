# auto-merger

> Squash-merges qualifying PRs without human intervention -- the final step in the cold chain from issue to shipped code.

| Property | Value |
|----------|-------|
| Type | Interval |
| Default interval | 10 minutes (`intervals.autoMergerMs`) |
| Uses AI | No |
| Backend | None (pure GitHub API operations) |
| Config key | `intervals.autoMergerMs` |

## What it does

The auto-merger watches open PRs and squash-merges those that meet specific criteria. It handles three categories of PRs, each with different merge requirements. No AI is needed -- this is purely a state-checking and merge operation.

## Trigger

The auto-merger runs on its polling interval and can also be triggered immediately by a GitHub webhook when a `pull_request_review` event with an `approved` state is received for an eligible PR. This means approved PRs can be merged within seconds rather than waiting for the next poll cycle.

Open PRs matching one of three categories:

1. **Dependabot PRs** -- authored by `dependabot[bot]`
2. **Doc PRs** -- branch name starts with `yeti/docs-`
3. **Issue PRs** -- branch name starts with `yeti/issue-` or `yeti/improve-`

All other PRs are ignored.

## Labels

| Label | Action |
|-------|--------|
| `In Review` | Removes from source issue (after merging a `yeti/issue-*` PR) |

## How it works

### Merge Criteria by Category

**Dependabot PRs:**

- All CI checks must be passing

**Doc PRs (`yeti/docs-*`):**

- All changed files must be under `yeti/` or end in `.md`
- CI checks must be passing **or** no checks configured
- Non-doc files in a doc PR cause it to be skipped with a warning

**Issue PRs (`yeti/issue-*`, `yeti/improve-*`):**

- A valid LGTM comment must be posted after the latest commit
- All CI checks must be passing

### Common Requirements

All categories share these requirements:

- PR must be in `MERGEABLE` state (no conflicts)
- PR must not be skipped via `skippedItems` config

### Branch Protection Handling

If a merge fails because the target repository has branch protection rules that prohibit the merge, the auto-merger skips that PR and continues with the remaining queue. This prevents a single protected repository from blocking merges in other repositories.

### Post-Merge Cleanup

After merging a `yeti/issue-*` PR:

1. Extracts the issue number from the branch name (`yeti/issue-<number>-...`)
2. Removes the `In Review` label from the source issue
3. Label removal failures are silently ignored (issue may already be closed)

The [issue-worker](issue-worker.md) then detects the merge on its next cycle and handles multi-PR phase continuation if needed.

### LGTM Validation

For issue/improve PRs, the `hasValidLGTM` function checks that:

- An LGTM-style comment exists on the PR
- The comment was posted **after** the most recent commit
- This ensures re-review after any changes

## Related jobs

- [issue-worker](issue-worker.md) -- Creates the PRs that auto-merger merges
- [ci-fixer](ci-fixer.md) -- Fixes CI failures that might block merging
- [doc-maintainer](doc-maintainer.md) -- Creates doc PRs that auto-merger merges
- [improvement-identifier](improvement-identifier.md) -- Creates improvement PRs that auto-merger merges
