# learning-consolidator

> Closes Yeti's self-improvement loop: folds agent-reported environment learnings into the durable policy and docs files via a pull request.

| Property | Value |
|----------|-------|
| Type | Scheduled (plus threshold trigger) |
| Default hour | 6 AM (`schedules.learningConsolidatorHour`) |
| Uses AI | Yes |
| Backend | Claude (configurable via `jobAi`) |
| Config key | `schedules.learningConsolidatorHour`, `learningsPendingThreshold` |
| Runs against | `selfRepo` only |

## What it does

During work sessions, agents declare environment/tooling friction with a `LEARNINGS-YETI:` line. The [self-improvement gate](../workflow.md#self-improvement-loop) persists each such learning to the `learnings` table with status `pending`. The learning-consolidator drains that queue: it runs one AI pass in a `selfRepo` worktree, folds the pending learnings into `src/policies/_preamble.md`, job policies, or `yeti/` docs, and opens a PR. Once a human merges it and the release flow deploys, every future agent prompt carries the learning.

Only **environment** learnings (`kind = "yeti"`) flow through this job. Repository-specific learnings are committed by agents as `yeti/learnings/<slug>.md` files directly in the target repo's PR and never reach Yeti.

## When it runs

- **Daily** at `schedules.learningConsolidatorHour` (default 6 AM local time). Like other scheduled jobs, it also runs on startup if that hour has already passed since the last run.
- **On threshold** — when the number of pending environment learnings reaches `learningsPendingThreshold` (default 5), the gate triggers the job immediately rather than waiting for the daily slot.

## How it works

1. **Capability check** — Requires the `pr` (createPR) [autonomy tier](../configuration.md#autonomy) on `selfRepo`; skips otherwise.
2. **Load pending learnings** — Reads all `pending` environment learnings from the database. Exits early if none.
3. **Skip if a learnings PR is open** — Bypasses the PR list cache (`fresh`) and skips if any open PR has a `yeti/learnings-*` branch.
4. **Worktree** — Creates a worktree on branch `yeti/learnings-<datestamp>-<suffix>`.
5. **Consolidate** — Renders the `learning-consolidator` policy with the pending learnings formatted as `[id]` bullets and runs the AI. The agent replies with machine-readable lines:
    - `FOLDED: <id>` — the learning was folded into a durable file.
    - `DISMISSED: <id>: <reason>` — the learning was rejected (stale, one-off, or invalid); it is marked `dismissed` in the DB.
6. **Create PR** — Only if there are folded (non-dismissed) learnings **and** the worktree has both new commits and an actual tree diff. The PR is titled `chore(learnings): consolidate N environment learning(s)` and its body lists the folded and dismissed learnings. Consolidated learnings are marked `consolidated` with the PR number.

If learnings were folded but no file changes were produced, they are left `pending` for a future run.

## Output

- A PR against `selfRepo` folding the learnings into policies/docs, plus a Discord notification.
- Database status transitions: `pending` → `consolidated` (merged into a PR) or `pending` → `dismissed` (rejected with a reason).

## Related

- [Self-Improvement Loop](../workflow.md#self-improvement-loop) — how learnings are declared and gated
- [doc-maintainer](doc-maintainer.md) — folds repo-side `yeti/learnings/*` seeds into topic docs
- [Configuration — Self-Improvement](../configuration.md#self-improvement-learnings)
