# Labels

Yeti manages six labels across all repositories it watches. These labels form the signaling layer of the issue lifecycle -- each one marks a distinct station in the journey from idea to merged code.

Labels are synced to repos by the [repo-standards](jobs/repo-standards.md) job, so you never need to create them manually.

---

## Label Summary

| Label | Color | Meaning |
|-------|-------|---------|
| **Needs Refinement** | Purple | This issue needs an AI-generated implementation plan |
| **Needs Plan Review** | Light blue | Plan awaiting adversarial AI review |
| **Ready** | Green | Yeti has finished -- needs human attention |
| **Refined** | Blue | Plan approved -- Yeti should implement this |
| **In Review** | Yellow | There is an open PR for this issue |
| **Priority** | Red | Process this item before others in all queues |

---

## Needs Refinement

> *"This issue needs an AI-generated implementation plan."*

The starting signal. When this label appears on an issue, the [issue-refiner](jobs/issue-refiner.md) picks it up and generates a detailed implementation plan.

| | Details |
|---|---------|
| **Set by** | Human (manually), [issue-auditor](jobs/issue-auditor.md) (if issue has no plan) |
| **Removed by** | [issue-refiner](jobs/issue-refiner.md) (after posting or updating the plan) |
| **Color** | `#d876e3` (purple) |

**Note:** Machine-generated issues (`[ci-unrelated]` and `[yeti-error]`) are exempt from requiring this label -- the issue-refiner processes them automatically based on their title prefix.

---

## Needs Plan Review

> *"Plan awaiting adversarial AI review before a human sees it."*

An intermediate step that only activates when the [plan-reviewer](jobs/plan-reviewer.md) job is enabled. The plan-reviewer critiques the implementation plan, looking for gaps, risks, and edge cases. The review is written for the human, not for automatic AI refinement.

| | Details |
|---|---------|
| **Set by** | [issue-refiner](jobs/issue-refiner.md) (after posting plan, if plan-reviewer is enabled) |
| **Removed by** | [plan-reviewer](jobs/plan-reviewer.md) (after posting review) |
| **Color** | `#c5def5` (light blue) |

If the plan-reviewer job is not in `enabledJobs`, this label is never used. The issue-refiner skips straight to adding `Ready` instead.

---

## Ready

> *"Yeti has finished its work -- a human needs to decide next steps."*

This label is Yeti's way of handing control back to a human. An issue with `Ready` has a plan (and possibly a review) waiting for someone to read and either approve it by adding `Refined`, or post feedback comments to trigger another refinement cycle.

| | Details |
|---|---------|
| **Set by** | [issue-refiner](jobs/issue-refiner.md) (after plan, if plan-reviewer disabled), [plan-reviewer](jobs/plan-reviewer.md) (after review), [review-addresser](jobs/review-addresser.md) (after addressing PR comments), [issue-auditor](jobs/issue-auditor.md) (for stuck items) |
| **Removed by** | [issue-worker](jobs/issue-worker.md) (when starting implementation), [issue-refiner](jobs/issue-refiner.md) (when new feedback arrives) |
| **Color** | `#0e8a16` (green) |

---

## Refined

> *"Plan approved -- Yeti should implement this."*

The green light. Adding this label tells the [issue-worker](jobs/issue-worker.md) to create a worktree, run Claude against the plan, and open a PR with the implementation.

| | Details |
|---|---------|
| **Set by** | Human (approval of plan), Discord `!yeti assign` command, [issue-worker](jobs/issue-worker.md) (re-labels for next phase in multi-PR workflows), [issue-refiner](jobs/issue-refiner.md) (auto-refines `[ci-unrelated]` issues) |
| **Removed by** | [issue-worker](jobs/issue-worker.md) (after creating PR or if a PR already exists) |
| **Color** | `#0075ca` (blue) |

---

## In Review

> *"There is an open PR for this issue."*

An informational label that tracks which issues currently have active pull requests. Helps keep the dashboard queue accurate and prevents duplicate work.

| | Details |
|---|---------|
| **Set by** | [issue-worker](jobs/issue-worker.md) (after creating PR), [issue-auditor](jobs/issue-auditor.md) (if PR is open but label is missing) |
| **Removed by** | [auto-merger](jobs/auto-merger.md) (after merge), [issue-auditor](jobs/issue-auditor.md) (if PR is no longer open) |
| **Color** | `#fbca04` (yellow) |

---

## Priority

> *"Process this item before others in all queues."*

A queue-ordering signal. Priority items are dequeued ahead of non-priority items in all AI worker queues. Can be set on both issues and PRs.

| | Details |
|---|---------|
| **Set by** | Human (via dashboard or manually) |
| **Removed by** | Human |
| **Color** | `#d93f0b` (red) |

When an issue has the Priority label and the issue-worker creates a PR for it, the Priority label is propagated to the new PR as well.

---

## Legacy Labels

The following labels were used by earlier versions of Yeti and are now obsolete. The [repo-standards](jobs/repo-standards.md) job automatically deletes them from all scanned repositories:

- `Plan Produced`
- `Reviewed`
- `prod-report`
- `investigated`
- `yeti-mergeable`
- `yeti-error`
