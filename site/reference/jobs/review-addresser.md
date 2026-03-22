# review-addresser

> Addresses PR review comments on Yeti-created pull requests, responding to feedback without waiting for the next thaw.

| Property | Value |
|----------|-------|
| Type | Interval |
| Default interval | 5 minutes (`intervals.reviewAddresserMs`) |
| Uses AI | Yes |
| Backend | Claude (configurable via `jobAi`) |
| Config key | `intervals.reviewAddresserMs` |

## What it does

When reviewers leave comments on Yeti-created PRs, the review-addresser picks them up and uses Claude to either make code changes or post text explanations. It handles both inline review comments and general PR comments, pushing changes and posting a summary when done.

## Trigger

Yeti-created PRs (branch starts with `yeti/`) with unaddressed review comments. A comment is considered "unaddressed" if it has no thumbsup reaction from Yeti.

Both regular issue comments and pull request review comments (inline code comments) are collected and processed together.

## Labels

| Label | Action |
|-------|--------|
| `Ready` | Removes (before processing, to signal work is in progress) |
| `Ready` | Sets (after addressing comments, to signal the PR needs another look) |

## How it works

1. Scans all open PRs across all repos for `yeti/` branches
2. Fetches review comments and issue comments on each PR
3. Filters to only unaddressed comments (no thumbsup reaction from Yeti)
4. If unaddressed comments exist:
   a. Removes the `Ready` label from the PR
   b. Creates a worktree from the PR branch
   c. Collects the formatted review data and any referenced images
   d. Feeds all review comments to Claude with instructions to make code changes or explain why no changes are needed
   e. If Claude produces commits with actual tree differences, pushes the changes
   f. Updates the PR description to reflect the changes
   g. Posts Claude's summary as a comment on the PR
   h. Reacts with thumbsup to each addressed comment (both regular and inline review comments)
   i. Adds the `Ready` label to signal the PR needs another review

### Comment Processing

The review-addresser processes both types of GitHub comments:

- **Issue comments** -- General comments on the PR conversation thread
- **Review comments** -- Inline comments attached to specific lines of code

Both are collected into a single formatted prompt for Claude. The thumbsup reactions are tracked separately for each comment type using different GitHub API endpoints.

## Related jobs

- [issue-worker](issue-worker.md) -- Creates the PRs that this job monitors
- [ci-fixer](ci-fixer.md) -- Also operates on open Yeti PRs
- [auto-merger](auto-merger.md) -- Merges PRs after review comments are addressed
