# Database Schema

Yeti uses SQLite (via `better-sqlite3`) stored at `~/.yeti/yeti.db`.
The database is configured with WAL journal mode and NORMAL synchronous
level for performance.

**Source**: `src/db.ts`

## `tasks` table

Tracks every job invocation. Used for crash recovery (orphaned task detection
at startup) and operational visibility.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Unique task identifier |
| `job_name` | TEXT | NOT NULL | Job that created this task (e.g. `issue-worker`, `ci-fixer`) |
| `repo` | TEXT | NOT NULL | Full repo name (e.g. `frostyard/yeti`) |
| `item_number` | INTEGER | NOT NULL | Issue or PR number (0 for doc-maintainer) |
| `trigger_label` | TEXT | nullable | Label that triggered this task |
| `worktree_path` | TEXT | nullable | Filesystem path to the task's worktree |
| `branch_name` | TEXT | nullable | Git branch name used by this task |
| `run_id` | TEXT | nullable | UUID of the parent job run (links to `job_runs.run_id`) |
| `status` | TEXT | NOT NULL, default `'running'` | One of: `running`, `completed`, `failed` |
| `error` | TEXT | nullable | Error message if status is `failed` |
| `started_at` | TEXT | NOT NULL | ISO timestamp when task started |
| `completed_at` | TEXT | nullable | ISO timestamp when task finished |

### Indexes

- `idx_tasks_status` on `status` — used by `getOrphanedTasks()` to find
  rows still in `running` state at startup
- `idx_tasks_run_id` on `run_id` — used by `getTasksByRunId()` and
  `getWorkItemsForRuns()` to fetch tasks for a specific job run

### Lifecycle

1. **Start**: `recordTaskStart()` inserts a row with status `running` and
   the current `run_id` (from `AsyncLocalStorage` context, linking the task
   to its parent job run)
2. **Worktree created**: `updateTaskWorktree()` fills in `worktree_path` and
   `branch_name` (these are null initially because they're set after the
   worktree is created)
3. **Complete**: `recordTaskComplete()` sets status to `completed` with
   timestamp
4. **Failed**: `recordTaskFailed()` sets status to `failed` with error
   message and timestamp

### Crash Recovery

`getOrphanedTasks()` returns all rows with `status = 'running'`. At startup,
`main.ts` iterates these and:
- Removes the worktree directory if it still exists on disk
- Marks the task as `failed` with error `"process restarted before completion"`

## `job_runs` table

Tracks each scheduled job execution. Created automatically on DB init.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Auto-increment ID |
| `run_id` | TEXT | NOT NULL UNIQUE | UUID identifying this run |
| `job_name` | TEXT | NOT NULL | Name of the job (e.g. `issue-worker`) |
| `status` | TEXT | NOT NULL, default `'running'` | One of: `running`, `completed`, `failed` |
| `started_at` | TEXT | NOT NULL | ISO timestamp when the run started |
| `completed_at` | TEXT | nullable | ISO timestamp when the run finished |

### Indexes

- `idx_job_runs_job_name` on `job_name`
- `idx_job_runs_started_at` on `started_at` — used by pruning

## `job_logs` table

Stores log output captured during job runs via `AsyncLocalStorage` context.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Auto-increment ID |
| `run_id` | TEXT | NOT NULL | UUID of the parent job run |
| `level` | TEXT | NOT NULL | Log level: `debug`, `info`, `warn`, or `error` |
| `message` | TEXT | NOT NULL | The log message |
| `logged_at` | TEXT | NOT NULL | ISO timestamp when the log was written |

### Indexes

- `idx_job_logs_run_id` on `run_id` — used to fetch logs for a specific run

### Pruning

Old runs and logs are pruned on startup and daily via `pruneOldLogs()`.
Retention is configured via `logRetentionDays` (default: 14 days) and
`logRetentionPerJob` (default: 20) in `~/.yeti/config.json`. The pruner
deletes runs older than the retention period but always keeps the most
recent N runs per job type. Orphaned log entries are cascade-deleted.

## `notifications` table

Stores recent notification history for the dashboard. Populated by
`notify.ts` whenever a notification is dispatched.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Unique notification identifier |
| `job_name` | TEXT | NOT NULL | Job that produced this notification (e.g. `issue-worker`) |
| `message` | TEXT | NOT NULL | Notification message text |
| `url` | TEXT | nullable | Optional GitHub URL associated with the notification |
| `level` | TEXT | NOT NULL | Severity: `info`, `warn`, or `error` |
| `created_at` | TEXT | NOT NULL | ISO timestamp when the notification was created |

### Notification Pruning

Notifications older than 7 days are pruned on startup and nightly by
`main.ts`. There is no per-job retention limit — all notifications within
the 7-day window are kept.

## `job_shas` table

Stores the last successfully processed default-branch head SHA for jobs that
gate scheduled work on repository changes.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `job_name` | TEXT | NOT NULL, PRIMARY KEY with `repo` | Job that processed the SHA (e.g. `mkdocs-update`) |
| `repo` | TEXT | NOT NULL, PRIMARY KEY with `job_name` | Full repo name (e.g. `frostyard/yeti`) |
| `sha` | TEXT | NOT NULL | Default-branch head SHA successfully processed by the job |
| `updated_at` | TEXT | NOT NULL | Timestamp when this SHA was recorded |

### Helpers

- `getLastJobSha(jobName, repo)` returns the recorded SHA or `null`
- `recordJobSha(jobName, repo, sha)` upserts the SHA for a job/repo pair

## `learnings` table

Backs the self-improvement loop's environment-side half (`src/learnings.ts`,
`src/jobs/learning-consolidator.ts`). A row is written whenever a work job's
`enforceLearnings()` gate parses a `LEARNINGS-YETI:` declaration out of an
agent's output. Repo-side learnings (`LEARNINGS-REPO:`) are **not** stored
here — they are committed as `yeti/learnings/<slug>.md` files in the target
repo's own PR and never touch this table.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | INTEGER | PRIMARY KEY AUTOINCREMENT | Unique learning identifier |
| `job_name` | TEXT | NOT NULL | Job that reported the learning (e.g. `issue-worker`, `ci-fixer`) |
| `repo` | TEXT | NOT NULL | Full repo name the agent was working in when it reported the learning |
| `kind` | TEXT | NOT NULL, CHECK `kind IN ('repo','yeti')` | `"repo"` or `"yeti"` — only `"yeti"` rows are currently inserted by `enforceLearnings()`; `kind` is stored for future use if repo learnings ever need DB tracking |
| `summary` | TEXT | NOT NULL | One-line summary of the learning (the text after `LEARNINGS-YETI:`), capped to 500 characters by `insertLearning()` |
| `status` | TEXT | NOT NULL, default `'pending'` | One of: `pending`, `consolidated`, `dismissed` |
| `reason` | TEXT | nullable | Set by `dismissLearning()` when the consolidator's AI pass judges the learning not actionable (from a `DISMISSED: <id>: <reason>` output line) |
| `pr_number` | INTEGER | nullable | Set by `markLearningsConsolidated()` — the PR number that folded this learning into policy/docs |
| `created_at` | TEXT | NOT NULL | ISO timestamp when the learning was recorded |

### Indexes

- `idx_learnings_status` on `status` — used by `getPendingLearnings()` /
  `countPendingLearnings()` to find pending rows without a full scan

Existing databases whose `learnings.kind` column predates the runtime CHECK are
migrated by `initDb()` with a guarded SQLite table rebuild.

### Dedup on insert

`insertLearning(jobName, repo, kind, summary)` caps `summary` to 500 characters,
then checks for an existing row with the same `kind` + capped `summary` and
`status = 'pending'`; if found, it returns that row's `id` instead of inserting
a duplicate. This means the same environment friction reported by multiple jobs
(or the same job across multiple runs) collapses into a single pending row
rather than spamming the consolidator with near-identical entries. Dedup is
exact-match on capped `summary` text, not fuzzy — near-duplicate phrasing still
inserts a new row.

### Lifecycle

1. **pending**: `insertLearning()` inserts (or dedups into) a row with
   `status = 'pending'` when a work job's gate parses a `LEARNINGS-YETI:`
   line. `enforceLearnings()` records at most the first five `LEARNINGS-YETI:`
   lines per run. Crossing from below `LEARNINGS_PENDING_THRESHOLD` to at or
   above it (default 5, configurable via `learningsPendingThreshold`) triggers
   the `learning-consolidator` job immediately, independent of its daily
   schedule; staying above the threshold does not retrigger it on every insert.
2. **consolidated**: `markLearningsConsolidated(ids, prNumber)` sets
   `status = 'consolidated'` and records `pr_number` when the consolidator
   successfully folds the learning into `_preamble.md`, a job policy, or a
   `yeti/` doc and opens a PR.
3. **dismissed**: `dismissLearning(id, reason)` sets `status = 'dismissed'`
   and records `reason` when the consolidator's AI judges the learning
   already covered, too vague, or not actionable (parsed from a
   `DISMISSED: <id>: <reason>` line in its output).

There is no automatic pruning for `learnings` rows — consolidated and
dismissed rows accumulate as history, surfaced via `GET /api/learnings` and
the dashboard's Learnings page.
