# Yeti — Overview

Yeti is a self-hosted
GitHub automation service. It polls GitHub repositories on configurable timers,
identifies work items via comment analysis, reactions, and PR state, and
delegates tasks to the Claude CLI in isolated git worktrees. It runs as a
Linux systemd service.

## Architecture

```
src/
├── main.ts              Entry point — DB init, crash recovery, job registration, shutdown
├── config.ts            Configuration loading (env > config file > defaults)
├── scheduler.ts         Interval/schedule-based job runner with skip-if-busy
├── github.ts            gh CLI wrapper with transient-error retry
├── github-app.ts        Optional GitHub App auth (JWT, installation tokens, GH_TOKEN injection)
├── oauth.ts             Optional GitHub OAuth for dashboard sign-in (stateless sessions, org membership)
├── claude.ts            Multi-backend AI dispatch (Claude + Copilot + Codex), BoundedQueue class, worktree helpers
├── db.ts                SQLite task tracking (better-sqlite3)
├── server.ts            HTTP server — dashboard, health, status, manual triggers
├── log.ts               Timestamped logging
├── notify.ts            Notification dispatcher — forwards to Discord
├── discord.ts           Discord bot — notifications + job control commands (!yeti …)
├── error-reporter.ts    Deduplicating GitHub issue-based error reporter (filters ShutdownError, RateLimitError)
├── images.ts            Image/attachment extraction + download for issue/PR context
├── version.ts           Build-time injected version string
├── plan-parser.ts       Parses multi-PR implementation plans into phases
├── startup-announce.ts  Announces new deployments via notify (version-change detection)
├── shutdown.ts          Graceful shutdown flag + ShutdownError class (shared across modules)
├── test-helpers.ts      Test factories (mockRepo, mockIssue, mockPR)
├── pages/
│   ├── dashboard.ts     Main status page HTML builder
│   ├── jobs.ts          Jobs page HTML builder (all jobs with backend/model/schedule)
│   ├── repos.ts         Repos page HTML builder (per-repo active/completed items, add repo dialog)
│   ├── queue.ts         Work queue page HTML builder
│   ├── logs.ts          Log list, detail, and issue logs page HTML builders
│   ├── config.ts        Config editor page HTML builder
│   ├── login.ts         Login page HTML builder
│   └── layout.ts        Shared layout (header, theme, siteTitle, formatters)
└── jobs/
    ├── issue-refiner.ts        Discovers issues needing plans via comment analysis
    ├── plan-reviewer.ts        Adversarial plan review using configurable AI backend
    ├── issue-worker.ts         Implements issues labelled "Refined" as PRs
    ├── ci-fixer.ts             Fixes failing CI and resolves merge conflicts
    ├── review-addresser.ts     Addresses review comments on Yeti PRs
    ├── triage-yeti-errors.ts       Investigates internal Yeti errors ([yeti-error] issues)
    ├── doc-maintainer.ts       Nightly documentation generation/update
    ├── auto-merger.ts          Auto-merges Dependabot and approved Yeti PRs
    ├── repo-standards.ts       Syncs labels and cleans legacy labels
    ├── improvement-identifier.ts  Identifies codebase improvements via Claude, implements as PRs
    ├── mkdocs-update.ts        Daily MkDocs documentation update from recent git changes
    ├── issue-auditor.ts        Daily audit ensuring no issues fall between the cracks
    └── prompt-evaluator.ts     Weekly self-improvement: A/B tests prompts, files issues for winners

scripts/
└── ab-agent-test.sh       A/B test harness comparing AI backends (Claude vs Codex) on real issues

deploy/
├── yeti.service           systemd service unit
├── yeti-updater.service   systemd updater service
├── yeti-updater.timer     systemd timer (every 60s)
├── install.sh              One-shot bootstrap installer (repo-aware)
├── deploy.sh               Auto-update with health check + rollback (repo-aware)
└── uninstall.sh            Service removal
```

### Module Responsibilities

**`main.ts`** — Wires everything together. Initializes the SQLite database,
recovers orphaned tasks from a previous crash (cleans up dangling worktrees,
marks tasks failed), prunes old logs, registers all 13 jobs with the scheduler
(interval jobs staggered by 2 seconds to prevent thundering herd), starts the
HTTP server, launches the **queue label scanner** (an infrastructure timer that
runs `scanQueueLabels()` on a configurable interval to keep the dashboard queue
populated independently of worker jobs — always runs regardless of
`enabledJobs`), sets up live config reloading (interval, schedule, and queue
scan interval changes propagated to the scheduler without restart), awaits
`discord.ready()` before announcing new deployments via `startup-announce.ts`
(sends a notification when the version changes, skipping `"dev"` and
same-version restarts; if Discord readiness times out, logs a warning and
continues), and installs SIGINT/SIGTERM handlers that cancel queued tasks,
drain running jobs (5 min timeout), terminate active Claude processes, clear
the queue scan interval, and close the database.

**`config.ts`** — Loads configuration in priority order: environment variables >
`~/.yeti/config.json` > hardcoded defaults. Exports `LABELS` (`refined`,
`ready`, `priority`, `inReview`, `needsRefinement`, `needsPlanReview`),
`LABEL_SPECS` (synced to all repos by repo-standards — includes colors and
descriptions for all six labels), `LEGACY_LABELS` (set of old labels cleaned up as stale: `Plan Produced`,
`Reviewed`, `prod-report`, `investigated`, `yeti-mergeable`, `yeti-error`), `INTERVALS`, `SCHEDULES`, `ENABLED_JOBS`,
and connection strings. `WORK_DIR` is always `~/.yeti`. Jobs must be listed in
`ENABLED_JOBS` (the `enabledJobs` config field) to be registered with the
scheduler — an empty or missing `enabledJobs` means no jobs start.

**`scheduler.ts`** — Manages job lifecycle. Each job runs immediately on
startup, then repeats on its interval. If a prior run is still active, the
incoming tick is silently skipped (no queuing). Supports `scheduledHour` mode
(fires once daily at a specific hour) with optional `runOnStart` for jobs
that should also fire immediately at startup (e.g. repo-standards). Exposes
`drain()` for graceful shutdown, `triggerJob(name)` for manual HTTP-triggered
runs, `updateInterval()` / `updateScheduledHour()` for live config
changes without restart, `pauseJob(name)` / `resumeJob(name)` for toggling
job execution via the dashboard, `jobScheduleInfo()` for exposing per-job
schedule metadata (interval or scheduled hour) to the dashboard, and exports
`msUntilHour()` for computing next-run countdowns. Paused jobs are
initialized from the `pausedJobs` config array on startup.

**`github.ts`** — All GitHub interaction via the `gh` CLI (never the HTTP API
directly). Wraps `execFile("gh", ...)` with exponential-backoff retry on
transient errors (400, 500, 502, 503, 504, ETIMEDOUT, ECONNRESET, ECONNREFUSED,
connection reset, "Could not resolve to a", "TLS handshake timeout",
"Something went wrong" — up to 3 attempts with 1s/2s/4s delays). Rate limit
errors are not retried — they trip a **circuit breaker** that blocks all API
calls for 60 seconds (throws `RateLimitError`). Includes GraphQL pagination for
resolved review thread filtering. Uses a generic `TTLCache` for API response
caching and in-flight request deduplication (PR lists, check status, issue
comments). Jobs populate a category-based queue cache via
`populateQueueCache()`, and the dashboard reads it via `getQueueSnapshot()`.
Categories: `ready`, `needs-refinement`, `refined`, `needs-review-addressing`,
`auto-mergeable`, `needs-triage`, `needs-plan-review`. The queue cache is fed
from two sources: (1) worker jobs populate it during their normal processing,
and (2) the `scanQueueLabels()` scanner populates a subset of categories
(`needs-refinement`, `needs-plan-review`, `refined`, `ready`) by directly
querying GitHub labels — this lightweight scanner runs on its own timer
(`QUEUE_SCAN_INTERVAL_MS`, default 5 min) as infrastructure independent of
`enabledJobs`, ensuring the dashboard stays populated even when no worker jobs
are enabled. `clearQueueCacheByCategories()` selectively clears scanner
categories before each scan to prevent stale entries. The `listRepos()` function
falls back to a stale cache when the fresh fetch returns empty (transient
failure protection). By default, only source (non-fork) repos are discovered;
set `includeForks` to `true` to include forked repos.
Provides `issueUrl()` and `pullUrl()` URL builder helpers used by job
notifications to include clickable GitHub links in Discord messages.
Provides `isItemSkipped()` and `isItemPrioritized()` helpers that check
items against the `skippedItems` and `prioritizedItems` config lists,
used by jobs to exclude or fast-track specific issues/PRs. Provides
reaction helpers (`addReaction`, `addReviewCommentReaction`,
`getCommentReactions`) and `getPRReviewDecision()` for review-based gating.
All comments posted by Yeti include a hidden `YETI_COMMENT_MARKER` and a
visible `YETI_VISIBLE_HEADER`, with helper functions `isYetiComment()` /
`stripYetiMarker()` for attribution when processing feedback. Comment
filtering uses `isYetiComment()` (marker-based) rather than self-login
comparison, ensuring correct behavior when the `gh` auth identity is the
same GitHub account as the human user. `hasValidLGTM()` accepts a
`baseBranch` parameter and filters out merge-from-base commits (e.g. from
ci-fixer resolving conflicts) so they don't invalidate an existing LGTM.
`getPRReviewComments()` skips bare "LGTM" issue-tab comments (approval
signals for auto-merger, not review feedback). `getPRCheckStatus()` returns
four states: `"passing"`, `"failing"`, `"pending"`, or `"none"` (no checks
exist at all — used by auto-merger to distinguish doc-only PRs that skip CI
from PRs with in-progress checks).

**`github-app.ts`** — Optional GitHub App authentication. When configured
(via `githubAppId`, `githubAppInstallationId`, `githubAppPrivateKeyPath`),
gives Yeti a separate bot identity so humans can approve its PRs under branch
protection. Signs JWTs (RS256 via Node.js `crypto.createSign`, numeric `iss` claim),
exchanges them for installation tokens via direct GitHub API calls using
`Bearer` auth headers, and sets `process.env.GH_TOKEN` so all `gh` and `git`
subprocess calls inherit the App identity automatically.
Token refresh is lazy with a 5-minute pre-expiry buffer and in-flight dedup.
`initGitHubApp()` is called once at startup; `ensureGitHubAppToken()` is called
before each job tick. If no App config is set, all functions are no-ops and
Yeti continues using personal `gh` CLI auth.

**`oauth.ts`** — Optional GitHub OAuth for dashboard sign-in. When
`githubAppClientId`, `githubAppClientSecret`, and `externalUrl` are all
configured, enables "Sign in with GitHub" on the login page. Handles the
full OAuth flow: generates authorization URLs (no `scope` parameter —
GitHub App OAuth ignores scopes, permissions come from the App config),
exchanges authorization codes for user access tokens via direct GitHub API
calls (not `gh` CLI), fetches user identity, and checks org membership
against `GITHUB_OWNERS` using the GitHub App installation token
(`process.env.GH_TOKEN`) via `GET /orgs/{org}/members/{username}` (returns
204 if member). The installation token is used for org checks because GitHub
App user OAuth tokens don't support scopes — the App's configured
Organization > Members: Read permission enables this. OR logic — any org
match is sufficient; personal usernames in `githubOwners` silently 404 and
are skipped. Sessions use HMAC-signed cookies (derived key from
`githubAppClientSecret`, 24h expiry) — no server-side session store. The
user access token is used only during the callback and is not persisted.
Zero external dependencies (Node.js `crypto` and `fetch()` only).

**`claude.ts`** — Two concerns: (1) **multi-backend AI dispatch** with three
bounded concurrent queues — one per backend (Claude, Copilot, Codex), each
implemented as a `BoundedQueue` instance with configurable concurrency
(`MAX_CLAUDE_WORKERS` default 2, `MAX_COPILOT_WORKERS` default 1,
`MAX_CODEX_WORKERS` default 1). `resolveEnqueue(aiOptions)` selects the
correct queue based on the backend in `AiOptions`. All jobs call `runAI()` through
`resolveEnqueue()` for backend-agnostic dispatch. (2) Git worktree helpers — `ensureClone`, `createWorktree`,
`createWorktreeFromBranch`, `removeWorktree`, `attemptMerge`, `pushBranch`,
`generatePRDescription`, etc. `ensureClone` (exported) clones a repo on first
use and on subsequent calls runs `git fetch --all --prune` followed by
`git checkout origin/<defaultBranch> --force` to refresh the main clone's
working directory — this ensures any code reading directly from the main clone
sees the latest remote state. The queue rejects
new tasks when the system is shutting down (via `shutdown.ts`, throwing
`ShutdownError`). Active Claude child processes are tracked for signal-based
cancellation (`cancelCurrentTask`). Concurrent clones to the same repo are
deduplicated. Claude is invoked via
`spawn("claude", ["-p", "--dangerously-skip-permissions"])` with the prompt
on stdin. Copilot uses the `-m` flag. Codex uses the `exec` subcommand with
`--full-auto` and the prompt as a positional argument (`promptVia:
"positional"` — the prompt is appended as the last CLI arg, after any
`--model` flag). PR description generation uses three-dot diff
(`origin/base...HEAD`) to isolate branch changes from concurrent
main-branch movement. Each Claude process has a configurable **timeout**
(`CLAUDE_TIMEOUT_MS`, default 20 minutes) — on expiry, SIGTERM is sent with a
10-second SIGKILL escalation. A 5-minute **heartbeat** logs PID, elapsed time,
and stdout byte count for observability. Timed-out processes throw
`ClaudeTimeoutError` (carries diagnostic fields: `lastOutput`, `lastStderr`,
`outputBytes`, `cwd`) which the error reporter includes in GitHub issue reports.

**`db.ts`** — SQLite database at `~/.yeti/yeti.db`. Three tables: `tasks`
(tracks every job invocation, linked to `job_runs` via `run_id`), `job_runs`
(tracks scheduled job executions), and `job_logs` (captures log output per run
via `AsyncLocalStorage` context). See [Database Schema](database-schema.md).

**`server.ts`** — Minimal `http.Server` with an embedded HTML/CSS/JS dashboard.
Routes:

- `GET /` — Dashboard: job status with Last Run/Next Run columns, "Run" buttons, queue overview
- `GET /repos` — Repos page: per-repo view of active queue items and recently completed tasks, Add Repo dialog for onboarding new repos
- `POST /repos/add` — Add a repo to the allowedRepos config
- `GET /jobs` — Jobs page: all jobs with descriptions, enabled/disabled state, AI backend/model, schedule, Run/Pause controls
- `GET /health` — JSON health check
- `GET /status` — JSON with jobs (including `jobSchedules` with per-job `nextRunIn` countdowns), `jobAi` (per-job backend/model config for live dashboard updates), uptime, queue, integrations
- `GET /login` / `POST /login` — Token-based authentication (also shows "Sign in with GitHub" when OAuth is configured)
- `GET /auth/github` — Initiate GitHub OAuth flow (redirect to GitHub)
- `GET /auth/callback` — OAuth callback (exchange code, set session cookie)
- `GET /auth/logout` — Clear session cookie, redirect to login
- `POST /trigger/:job` — Manual job trigger (returns 200/409/404)
- `POST /pause/:job` — Toggle pause/resume for a job
- `POST /cancel` — Cancel current Claude task
- `GET /queue` — Work queue page (PRs first, CI status, squash & merge)
- `POST /queue/merge` — Squash-merge a PR from the queue page
- `POST /queue/skip` — Skip an issue/PR (excluded from all job processing)
- `POST /queue/unskip` — Remove skip for an issue/PR
- `POST /queue/prioritize` — Prioritize an issue/PR (processed first)
- `POST /queue/deprioritize` — Remove priority for an issue/PR
- `GET /logs` — Log viewer with per-job filtering and item search
- `GET /logs/:runId` — Individual run detail page with task list
- `GET /logs/:runId/tail` — Live log tail (JSON, polls for new entries)
- `GET /logs/issue` — Issue-specific logs page (`?repo=...&number=...`)
- `GET /config` / `POST /config` — Config viewer/editor (HTML form)
- `GET /config/api` — JSON config (sensitive fields masked)

Supports dark/light/system themes. Auth is enabled when `authToken` is set
or OAuth is configured (either or both). Accepts `Authorization: Bearer
<token>` header, `yeti_token` cookie (token auth), or `yeti_session` cookie
(OAuth). Token comparison uses `crypto.timingSafeEqual`.

**`plan-parser.ts`** — Parses structured implementation plan comments into
discrete phases for multi-PR workflows. Looks for `### PR N:` or `### Phase N:`
headers to split a plan into phases. Also provides `findPlanComment()` to locate the
most recent plan comment in an issue's comment history (uses `includes` rather
than `startsWith` so it still matches when the Yeti visible header is
prepended). Used by issue-worker to implement multi-phase plans sequentially.

**`log.ts`** — Timestamped console logging with four levels: `debug`, `info`,
`warn`, `error`. Errors also trigger notifications via `notify.ts`. All log calls capture
output into the `job_logs` table via `AsyncLocalStorage`-based run context, so
logs are associated with the job run that produced them.

**`error-reporter.ts`** — On error: logs to console (+ Discord via notify), then (with a
30-minute per-fingerprint cooldown) either comments on an existing
`[yeti-error]` issue in `SELF_REPO` or creates a new one (no label
applied — discovery is by title pattern). These issues are then picked up by the
triage-yeti-errors job for automated investigation. Two error types are
filtered before any reporting: `ShutdownError` (logged at info level —
shutdown cancellations are expected) and `RateLimitError` (logged at warn
level — handled by the circuit breaker, not actionable bugs). When the error
is a `ClaudeTimeoutError`, the report includes a diagnostics section with
working directory, stdout byte count, whether Claude was producing output,
and collapsible last stdout/stderr snippets.

**`images.ts`** — Extracts image references (markdown `![](url)` and HTML
`<img>` tags) from issue/PR text, downloads them (up to 10 images, 10 MB
each, 30s timeout), and writes them into the worktree under `.yeti-images/`.
Also extracts GitHub file attachments (`[filename](github-attachment-url)`),
downloads them (up to 5 attachments, 1 MB each), validates UTF-8 encoding,
and truncates large text content (100K char limit, keeps first/last halves).
Auto-detects the GitHub token for private image access. Skips badges, data
URLs, and binary attachment types. The main entry point `processTextForImages()`
runs both pipelines and returns a combined prompt section. Used by
issue-refiner, issue-worker, and review-addresser to give Claude visual and
file context.

**`startup-announce.ts`** — Announces new deployments. Compares the current
`VERSION` against `~/.yeti/last-version`; if they differ (or the file doesn't
exist), sends a notification via `notify()` and updates the file. Skips the
announcement when `VERSION` is `"dev"` (local development) or matches the
stored version (same-version restart / crash recovery). Checks
`discordStatus().connected` and logs a warning (rather than a success message)
when Discord is not connected at announcement time.

**`notify.ts`** — Notification dispatcher. Forwards to `discord.ts` so callers only need one import. All internal modules that send notifications import from `notify.ts`. Jobs announce key outcomes via `notify()`: PR creation (issue-worker, improvement-identifier, doc-maintainer, mkdocs-update), PR merge (auto-merger), plan production/update (issue-refiner), plan review (plan-reviewer), CI fix push and merge conflict resolution (ci-fixer), and review addressing (review-addresser). Messages use a `[job-name]` prefix for scannability and include GitHub links (via `issueUrl`/`pullUrl` from `github.ts`) that Discord auto-embeds.

**`discord.ts`** — Discord bot integration using discord.js. Connects as a bot user, sends notifications to a configured channel, and handles `!yeti` commands from authorised users. Commands: `status`, `jobs`, `trigger <job>`, `pause <job>`, `resume <job>`, `issue <repo> <title>`, `look <repo>#<number>`, `assign <repo>#<number>`, `recent [job]`, `help`. Requires `discordBotToken`, `discordChannelId`, and `discordAllowedUsers` in config. Only processes messages from the configured channel and from users in the allow-list. Uses `console.log` for its own error output to avoid recursive notify loops. The scheduler reference is injected at startup to enable job control commands. Exports a `ready()` function that returns a `Promise<void>` resolving when the bot's WebSocket handshake completes and the channel is available (10-second timeout; resolves immediately if Discord is not configured). Used by `main.ts` to ensure notifications can be delivered before the deployment announcement. See [Discord Setup](discord-setup.md).

### Dashboard (`src/pages/`)

The web dashboard is a first-class consumer of job, config, and queue data. Page builders in `src/pages/` render HTML for the dashboard routes in `server.ts`. `layout.ts` exports a `siteTitle()` helper that builds page titles from `GITHUB_OWNERS` (e.g. "yeti — frostyard — Queue"), reading the config at call time for live-reload compatibility. Navigation: Dashboard → Jobs → Queue → Logs → Config. The Jobs page (`/jobs`) lists all known jobs with descriptions, enabled/disabled state, AI backend, model override, schedule, and Run/Pause controls. `createServer()` accepts a `JobInfo[]` array from `main.ts` so the Jobs page can show schedule info for all jobs (including disabled ones not registered with the scheduler). Any changes to config fields, job states, queue categories, or log/task schemas must be reflected in the corresponding page builders — the dashboard is not optional.

## Jobs

Thirteen scheduled jobs run on timers or schedules.
See [Jobs](jobs.md) for detailed behavior of each.

| Job | Trigger | Interval | Summary |
|-----|---------|----------|---------|
| `issue-refiner` | Issues labelled `Needs Refinement` | 5 min | Posts implementation plans for issues with `Needs Refinement` label (exempt: `[ci-unrelated]` and `[yeti-error]` issues); asks clarifying questions for underspecified issues instead of guessing; refines plans based on unreacted human feedback; responds to follow-up questions on issues with open PRs |
| `plan-reviewer` | Issues labelled `Needs Plan Review` | 10 min | Adversarial review of implementation plans using configurable AI backend |
| `issue-worker` | Label `Refined` | 5 min | Implements the issue, creates a PR |
| `ci-fixer` | Any open PR with failing checks | 10 min | Resolves merge conflicts, fixes CI failures |
| `review-addresser` | Yeti PRs with unreacted review comments | 5 min | Fetches unresolved review comments, pushes fix commits, reacts with thumbsup to track addressed comments |
| `triage-yeti-errors` | `[yeti-error]` issues in `SELF_REPO` | 10 min | Investigates internal Yeti errors, deduplicates by fingerprint, posts report |
| `doc-maintainer` | Daily at 1 AM | Scheduled | Updates `yeti/` to reflect current codebase |
| `auto-merger` | Dependabot PRs + LGTM'd Yeti PRs + doc PRs | 10 min | Squash-merges PRs when conditions are met; silently skips branch-protected repos |
| `repo-standards` | Daily at 2 AM (+ on startup) | Scheduled | Syncs labels and cleans legacy labels |
| `improvement-identifier` | Daily at 3 AM | Scheduled | Analyzes codebase via Claude, implements improvements as PRs |
| `mkdocs-update` | Daily at 4 AM | Scheduled | Updates MkDocs documentation from recent source code changes |
| `issue-auditor` | Daily at 5 AM | Scheduled | Reconciles issue states, manages Ready and In Review labels |
| `prompt-evaluator` | Daily at midnight | Scheduled | A/B tests plan-producing prompts against AI-generated variants, files issues for improvements |

## Key Patterns

### Content-Based State Machine

Issues and PRs are discovered by analysing comments, reactions, and PR state —
not labels. Six labels are used:

- `Needs Refinement` — trigger for issue-refiner (requests an AI-generated implementation plan)
- `Needs Plan Review` — trigger for plan-reviewer (requests adversarial AI review of the plan)
- `Refined` — trigger for issue-worker (requests implementation of the plan)
- `Ready` — informational, signals "Yeti is done, your turn"
- `In Review` — informational, signals an issue has an open PR under review
- `Priority` — high-priority items processed first in all Yeti queues

```
Issues:
  Needs Refinement label →  (refiner posts plan)         →  Needs Plan Review added (if plan-reviewer enabled) or Ready added
  Needs Plan Review label → (plan-reviewer critiques)    →  Needs Plan Review removed, Ready added
  Unreacted feedback     →  (refiner refines plan)       →  Needs Plan Review or Ready label re-added
  Open PR + follow-up Q  →  (refiner posts response)     →  👍 reactions added (no label changes)
  Refined label          →  (worker creates PR)          →  Refined removed, Ready removed, In Review added
  [yeti-error] title    →  (triage-yeti-errors)        →  investigation report posted

PRs:
  Unreacted review comments  →  (review-addresser)  →  👍 reactions added, Ready added
  Dependabot or LGTM'd Yeti PR + passing CI  →  (auto-merger)  →  merged, In Review removed
  Doc PR (yeti/docs-*) + doc-only files + CI passing/skipped  →  (auto-merger)  →  merged (no LGTM required)
```

Jobs track processed items via 👍 reactions on comments (issue-refiner,
review-addresser) and by checking for existing report comments (triage jobs).
The issue-auditor reconciles label state daily, adding missing `In Review`
labels to issues with open PRs and removing stale ones.

### Multi-Backend AI Dispatch

All AI invocations go through `claude.ts`, which manages three independent
bounded concurrent queues — one per backend (Claude, Copilot, Codex). Each
queue has its own concurrency limit and timeout:

| Backend | Queue | Workers config | Default | Timeout config | Default |
|---------|-------|----------------|---------|----------------|---------|
| Claude | `enqueue` | `maxClaudeWorkers` | 2 | `claudeTimeoutMs` | 20 min |
| Copilot | `enqueueCopilot` | `maxCopilotWorkers` | 1 | `copilotTimeoutMs` | 20 min |
| Codex | `enqueueCodex` | `maxCodexWorkers` | 1 | `codexTimeoutMs` | 20 min |

All jobs use `resolveEnqueue(aiOptions)` to select the correct queue based on
the `JOB_AI` config for that job, then call `runAI()` for backend-agnostic
execution. This means any job can be switched to a different AI backend by
setting `jobAi.<job-name>.backend` in `config.json` — no code changes needed.

Each process has a configurable timeout with SIGTERM/SIGKILL escalation. A
5-minute heartbeat logs PID, elapsed time, and stdout byte count. Timed-out
processes throw `ClaudeTimeoutError` with diagnostic fields, surfaced in error
reports for debugging. `runAI()` rejects its promise on non-zero exit codes
(error includes exit code and first 500 bytes of stderr), ensuring AI process
failures propagate to job-level error handling and `reportError()` rather than
being silently swallowed.

### Skip-If-Busy Scheduling

Jobs that fire while a prior instance is still running are silently dropped —
no queue pile-up. This is distinct from the Claude task queue; a job can be
"running" while waiting in the Claude queue.

### Worktree Isolation

Each task gets its own git worktree at
`~/.yeti/worktrees/<owner>/<repo>/<job>/<branch>`. The job namespace prevents
filesystem path collisions. Worktrees for existing branches use detached HEAD
mode, allowing multiple jobs to work on the same branch concurrently without
git's branch-lock conflict. The main clone lives at
`~/.yeti/repos/<owner>/<repo>`. Worktrees are always cleaned up in a `finally`
block after each task.

### Graceful Shutdown

On SIGINT/SIGTERM, `main.ts` cancels all queued (not yet started) Claude tasks,
drains running jobs (5-minute timeout), terminates any in-flight Claude
processes (5-second grace period), closes the database, and exits. The
`shutdown.ts` module provides a shared `isShuttingDown()` flag that prevents
the Claude queue from accepting new tasks during shutdown. Cancelled tasks
throw `ShutdownError` (a distinct error class), which the error reporter
suppresses — no notifications or GitHub issues are created for shutdown
cancellations.

### Crash Recovery

At startup, any tasks still marked `running` in the database (from a previous
crash) have their worktrees cleaned up and are marked `failed`.

### Transient Retry & Rate Limit Circuit Breaker

The `gh` CLI wrapper retries up to 3 times with exponential backoff (1s, 2s,
4s) on transient errors (400, 500, 502, 503, 504, timeouts, connection resets,
"Could not resolve to a", "TLS handshake timeout", "Something went wrong").
Rate limit errors are handled separately: they trip a circuit breaker that
blocks all GitHub API calls for 60 seconds, throwing `RateLimitError`
immediately without retry. A notification is sent when the
circuit breaker trips, and another when the first API call succeeds after
cooldown expires. Jobs that iterate over repos short-circuit their loops via
`isRateLimited()` to avoid cascading failures during a rate-limit window.

### Error Reporting & Investigation Pipeline

Errors flow through two stages:

1. **Error reporter** (`error-reporter.ts`) — Uses a 30-minute cooldown per
   fingerprint. Recurrences add comments to the existing `[yeti-error]` issue
   rather than opening new ones. `ShutdownError` and `RateLimitError` are
   filtered before any reporting.
2. **Triage** (`triage-yeti-errors.ts`) — Discovers `[yeti-error]` issues
   by title pattern (no label required), runs two-phase deduplication (by
   fingerprint before investigation, then by root cause after), and posts an
   investigation report. Reads `yeti/OVERVIEW.md` for context and identifies
   related issues that share the same root cause.

### CI-Fixer Two-Phase Design

The ci-fixer uses a two-phase identify/process pattern (matching the pattern
used by improvement-identifier and issue-refiner):

1. **Identify**: Scans all PRs, checks merge state, CI status, and classifies
   failures — collects typed `WorkItem` entries (a discriminated union with
   variants: `conflict`, `rerun`, `unrelated`, `fix`)
2. **Process**: Groups unrelated failures by repo (structural dedup — one
   consolidated issue per repo), then processes remaining items concurrently

This eliminates race conditions when multiple PRs in the same repo have
unrelated CI failures — without the grouping, concurrent `searchIssues` +
`createIssue` calls would produce duplicate issues.

Reruns are emitted both for cancelled/startup-failure workflows and when
failure log fetching returns empty (the `getFailedRunLog` two-tier fallback —
CLI then REST API — both returned no output). Benign "already running" errors
(a harmless race condition where the workflow restarted between detection and
rerun) are caught and logged at info level rather than reported as errors.

**`[ci-unrelated]` fix PRs**: When ci-fixer processes a PR whose title
contains `[ci-unrelated]` (i.e., a PR created by issue-worker to fix a
`[ci-unrelated]` issue), it skips the classification step entirely and treats
all CI failures as related. Without this guard, the classifier would see the
pre-existing failures, classify them as "unrelated to the PR's changes", and
the PR would stall indefinitely in a loop of filing redundant issues and
reverting fix attempts. Errors on these PRs are posted as comments directly
on the PR rather than creating `[yeti-error]` issues.

### Image & Attachment Context

When processing issues or PR reviews, `images.ts` extracts embedded image
references and GitHub file attachments from the text, downloads them, and
appends prompt sections so Claude can view images and read attached files.
Images are saved into the worktree; text attachments are inlined in the
prompt. This is used by issue-refiner, issue-worker, and review-addresser.

### Documentation as Context

Issue-refiner, issue-worker, improvement-identifier, and triage-yeti-errors
prompts instruct Claude to read `yeti/OVERVIEW.md` (and linked docs) before
starting work. This gives Claude accumulated architectural context about each
repository.

### Branch Naming

| Job | Pattern |
|-----|---------|
| issue-refiner | `yeti/plan-<N>-<hex4>` |
| issue-worker | `yeti/issue-<N>-<hex4>` |
| triage-yeti-errors | `yeti/investigate-error-<N>-<hex4>` |
| doc-maintainer | `yeti/docs-<YYYYMMDD>-<hex4>` |
| improvement-identifier | `yeti/improve-<hex4>` |
| mkdocs-update | `yeti/mkdocs-update-<YYYYMMDD>-<hex4>` |
| ci-fixer / review-addresser | Uses existing PR branch |

### PR Title Conventions

- `fix: resolve #N — <title>` — single-PR issue implementations
- `fix(#N): <phase title> (X/Y)` — multi-PR issue phases
- `refactor: <title>` — automated improvements
- `docs: update documentation for <repo>` — doc maintenance
- `docs: update mkdocs content for <repo>` — mkdocs updates

### Tree-Diff Guard

All PR-creating jobs gate on both `hasNewCommits` (commit count vs base) and
`hasTreeDiff` (actual tree difference via `git diff --quiet`) before
pushing or creating PRs. This prevents failures when Claude makes commits
that produce no effective changes (e.g. reverting its own work). Jobs that
push to existing PR branches (ci-fixer, review-addresser) also use this
check to avoid pushing identical trees.

### Duplicate PR Guards

PR-creating jobs check for existing open PRs before creating new ones to
prevent pile-up when previous PRs haven't been merged:

- **doc-maintainer**: Skips if an open `yeti/docs-*` PR exists
- **improvement-identifier**: Skips if any open `yeti/improve-*` PR exists
- **mkdocs-update**: Skips if an open `yeti/mkdocs-update-*` PR exists
- **ci-fixer**: Uses consolidated per-repo `[ci-unrelated]` issues rather
  than per-fingerprint issues, so all unrelated CI failures for a repo
  are tracked in a single issue

`getOpenPRForIssue()` (used by issue-worker) bypasses the `listPRs` TTL
cache (`fresh: true`) to avoid race conditions where a concurrent PR is
invisible during the 60-second cache window.

### Item Skip & Prioritize

Individual issues/PRs can be skipped or prioritized via `skippedItems` and
`prioritizedItems` in `config.json` (arrays of `{repo, number}`), or via
the dashboard queue page buttons (`POST /queue/skip`, `/queue/prioritize`).
Skipped items are excluded from all job processing via `isItemSkipped()`.
Prioritized items are processed before others in job queues via
`isItemPrioritized()`. Both lists are hot-reloadable.

### Job Pause/Resume

Individual jobs can be paused and resumed via the dashboard (`POST /pause/:job`)
or pre-configured via `pausedJobs` in `config.json`. Paused jobs skip their
scheduled ticks but can still be triggered manually.

### Commit Tag

Doc-maintainer commits include `[doc-maintainer]` in the message. This is used
by `getLastDocMaintainerSha()` to detect whether docs are already up-to-date.

## Configuration

Configuration is resolved per-field: env vars > `~/.yeti/config.json` >
defaults.

| Config key | Env variable | Default |
|---|---|---|
| `githubOwners` | `YETI_GITHUB_OWNERS` | `["frostyard"]` |
| `selfRepo` | `YETI_SELF_REPO` | `frostyard/yeti` |
| `port` | `PORT` | `9384` |
| `intervals.issueWorkerMs` | — | `300000` (5 min) |
| `intervals.issueRefinerMs` | — | `300000` (5 min) |
| `intervals.ciFixerMs` | — | `600000` (10 min) |
| `intervals.reviewAddresserMs` | — | `300000` (5 min) |
| `intervals.autoMergerMs` | — | `600000` (10 min) |
| `intervals.triageYetiErrorsMs` | — | `600000` (10 min) |
| `intervals.planReviewerMs` | — | `600000` (10 min) |
| `schedules.docMaintainerHour` | — | `1` (1 AM local time) |
| `schedules.repoStandardsHour` | — | `2` (2 AM local time) |
| `schedules.improvementIdentifierHour` | — | `3` (3 AM local time) |
| `schedules.mkdocsUpdateHour` | — | `4` (4 AM local time) |
| `schedules.issueAuditorHour` | — | `5` (5 AM local time) |
| `schedules.promptEvaluatorHour` | — | `0` (midnight local time) |
| `logRetentionDays` | — | `14` |
| `logRetentionPerJob` | — | `20` |
| `discordBotToken` | `YETI_DISCORD_BOT_TOKEN` | *(empty — Discord disabled if unset)* |
| `discordChannelId` | `YETI_DISCORD_CHANNEL_ID` | *(empty)* |
| `discordAllowedUsers` | `YETI_DISCORD_ALLOWED_USERS` | `[]` (comma-separated user IDs) |
| `maxClaudeWorkers` | `YETI_MAX_CLAUDE_WORKERS` | `2` |
| `claudeTimeoutMs` | `YETI_CLAUDE_TIMEOUT_MS` | `1200000` (20 min, minimum 60s) |
| `maxCopilotWorkers` | `YETI_MAX_COPILOT_WORKERS` | `1` |
| `copilotTimeoutMs` | `YETI_COPILOT_TIMEOUT_MS` | `1200000` (20 min, minimum 60s) |
| `maxCodexWorkers` | `YETI_MAX_CODEX_WORKERS` | `1` |
| `codexTimeoutMs` | `YETI_CODEX_TIMEOUT_MS` | `1200000` (20 min, minimum 60s) |
| `includeForks` | `YETI_INCLUDE_FORKS` | `false` (only source repos discovered) |
| `jobAi` | — | `{}` (per-job AI backend/model overrides — all jobs respect this) |
| `authToken` | `YETI_AUTH_TOKEN` | *(empty — auth disabled)* |
| `githubAppClientId` | `YETI_GITHUB_APP_CLIENT_ID` | *(empty — OAuth disabled)* |
| `githubAppClientSecret` | `YETI_GITHUB_APP_CLIENT_SECRET` | *(empty — OAuth disabled)* |
| `externalUrl` | `YETI_EXTERNAL_URL` | *(empty — OAuth disabled; must start with http:// or https://)* |
| `pausedJobs` | — | `[]` (job names to pause on startup) |
| `enabledJobs` | — | `[]` (job names to register with the scheduler; empty = no jobs run) |
| `skippedItems` | — | `[]` (array of `{repo, number}` excluded from processing) |
| `allowedRepos` | `YETI_ALLOWED_REPOS` | `null` (all repos) |
| `prioritizedItems` | — | `[]` (array of `{repo, number}` processed first) |
| `queueScanIntervalMs` | — | `300000` (5 min — how often the dashboard queue refreshes from GitHub labels; infrastructure, always runs) |

### enabledJobs

Controls which jobs are registered with the scheduler at startup.

- **Field**: `enabledJobs` (string array)
- **Default**: `[]` — no jobs run if the field is absent or empty
- **Live-reloadable**: yes (changes take effect without restart)
- **Available values**: `issue-worker`, `issue-refiner`, `plan-reviewer`, `ci-fixer`, `review-addresser`, `doc-maintainer`, `auto-merger`, `repo-standards`, `improvement-identifier`, `issue-auditor`, `triage-yeti-errors`, `mkdocs-update`, `prompt-evaluator`

**Migration note**: existing configs without `enabledJobs` will have no jobs start after upgrading. Add the desired job names to `enabledJobs` in `~/.yeti/config.json` before upgrading.

### allowedRepos

Restricts which repositories Yeti processes. Applied as a filter on `listRepos()`.

- **Field**: `allowedRepos` (string array or `null`)
- **Env var**: `YETI_ALLOWED_REPOS` (comma-separated)
- **Default**: `null` — no filtering, all discovered repos are processed
- **Live-reloadable**: yes
- `null` = all repos; `[]` = selfRepo only; `["repo-a", "repo-b"]` = those repos + selfRepo
- `selfRepo` is always included regardless of the list (ensures Yeti can always process its own error issues)
- Matching is case-insensitive; uses short repo names (not `owner/repo`)
- Warns at runtime if a configured name doesn't match any discovered repository (includes a hint about `includeForks` when fork discovery is disabled)
- Editable via the dashboard config UI; empty input maps to `[]` (no repos except selfRepo), not `null` (all repos). To restore `null` (all repos), remove the `allowedRepos` key from `config.json` directly.

### includeForks

Controls whether forked repositories are included in discovery.

- **Field**: `includeForks` (boolean)
- **Env var**: `YETI_INCLUDE_FORKS`
- **Default**: `false` — only source (non-fork) repos are discovered via `gh repo list --source`
- **Live-reloadable**: yes (clearing both the repo cache and the all-org-repos cache)
- When `true`, the `--source` flag is omitted from `gh repo list`, so forks in the org appear alongside source repos
- Affects both `listRepos()` (worker discovery) and `listAllOrgRepos()` (Repos onboarding page)
- PRs created on forks stay within the fork — `gh pr create --repo <fork>` targets the fork, not the upstream parent

Config changes made via the web UI (`POST /config`) take effect immediately
at runtime — no restart required. The config module uses ESM live bindings
(`export let`) so all consumers see updated values on their next access.
Interval and schedule changes are propagated to the scheduler via
`onConfigChange()` listeners that call `updateInterval()` /
`updateScheduledHour()`. The only exception is `port` (requires socket
re-bind), which is shown as read-only in the UI.

Env vars always take priority over `config.json`. Fields set via env var
are shown as disabled in the config UI with a note indicating the override.

External tools `gh` and `claude` must be authenticated separately — Yeti does
not manage their credentials.

The Discord integration requires creating a Discord application, bot token, and private channel. See
[Discord Setup](discord-setup.md) for the full walkthrough.

## Technology Stack

- **Runtime**: Node.js 22
- **Language**: TypeScript (strict mode, ES2022 target, Node16 modules, ESM)
- **Database**: SQLite via better-sqlite3 (WAL mode)
- **Testing**: Vitest — co-located test files, heavy mocking of external boundaries
- **CI**: GitHub Actions on self-hosted runner — build + test on every push
- **History cleanup**: Workflow-dispatch action for branch cleanup and `git-filter-repo` to audit/scrub git secrets
- **Releases**: Date-based version tags (`v<YYYY-MM-DD>.<N>`), self-describing tarball attached to GitHub Release (includes `.repo` file identifying the source repository)
- **Auto-updates**: systemd timer checks for new releases every 60s, downloads + swaps + health checks with automatic rollback
- **Multi-instance deploy**: Release tarballs embed a `.repo` file so multiple instances (from different forks) can run independently on the same host

## Deployment & Multi-Instance Support

Release tarballs are **self-describing**: the CI workflow writes the source
repository (`owner/repo`) into a `.repo` file embedded in the tarball. Both
`deploy.sh` and `install.sh` use a three-level fallback to determine which
GitHub repository to monitor for updates:

1. `$INSTALL_DIR/.repo` — from the release tarball (highest priority)
2. `selfRepo` from `~/.yeti/config.json` — manual override
3. Default `frostyard/yeti` — backwards compatibility

This enables **multi-instance deployments**: different forks of Yeti can each
release their own tarball, and multiple instances can coexist on the same host
(using different `INSTALL_DIR` or systemd units), each self-updating from its
own fork's releases. The `install.sh` bootstrap script pre-populates
`selfRepo` and `githubOwners` in the initial config from the detected repo.

**Dynamic user detection**: `deploy.sh` resolves the service user dynamically
by reading the `User=` directive from the installed systemd unit file
(`/etc/systemd/system/yeti.service`), then derives the home directory via
`getent passwd`. This avoids hardcoding a username, allowing the service to
run as any user without modifying deploy scripts.

## Filesystem Layout (Runtime)

```
~/.yeti/
├── config.json          Configuration file
├── env                  Environment overrides (loaded by systemd)
├── yeti.db             SQLite database
├── last-version         Tracks last announced version (deployment announcements)
├── repos/
│   └── <owner>/<repo>/  Main clone per repository
└── worktrees/
    └── <owner>/<repo>/
        └── <job>/
            └── <branch>/   Isolated worktree per task

/opt/yeti/               (INSTALL_DIR — deployment artifacts)
├── .repo                Source repository (e.g. "frostyard/yeti")
├── .current-version     Currently deployed version tag
├── dist/                Compiled TypeScript output
├── deploy/              Deployment scripts
└── node_modules/        Runtime dependencies
```
