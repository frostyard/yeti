# Module Responsibilities

Detailed descriptions of each core module in `src/`.

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
"Something went wrong", "stream error" — up to 3 attempts with 1s/2s/4s delays). Rate limit
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
before each job tick. `configureWebhook()` auto-sets the App's webhook URL and
secret on startup via `PATCH /app/hook/config` (JWT auth) — idempotent, logs
a warning on failure. If no App config is set, all functions are no-ops and
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
- `GET /config` / `POST /config` — Config viewer/editor (tabbed HTML form with General, Scheduling, AI Backends, Integrations, Security tabs; supports `?tab=` param for direct tab linking; progressive enhancement with JS tab switching and `<a>` fallback)
- `GET /config/api` — JSON config (sensitive fields masked)
- `POST /webhooks/github` — GitHub webhook endpoint (HMAC-SHA256 verified, no auth required — see `webhooks.ts`)

Supports dark/light/system themes. Auth is enabled when `authToken` is set
or OAuth is configured (either or both). Accepts `Authorization: Bearer
<token>` header, `yeti_token` cookie (token auth), or `yeti_session` cookie
(OAuth). Token comparison uses `crypto.timingSafeEqual`.

**`webhooks.ts`** — GitHub webhook handler for near-real-time event processing.
Receives events via `POST /webhooks/github` with HMAC-SHA256 signature
verification (`X-Hub-Signature-256` header, using `WEBHOOK_SECRET`). Routes
three event types:

- **`ping`** — Returns `pong` (GitHub sends this when the webhook is first configured)
- **`issues.labeled` / `issues.unlabeled`** — Updates the dashboard queue cache
  in real time (adds/removes entries based on `LABEL_TO_CATEGORY` mapping) and
  triggers the corresponding job when a trigger label is added (`Refined` →
  issue-worker, `Needs Refinement` → issue-refiner, `Needs Plan Review` →
  plan-reviewer). `Priority` label changes update priority flags on existing
  cache entries.
- **`check_run.completed`** — When a check run concludes with `failure` or
  `timed_out` and is associated with a PR, triggers ci-fixer.

All events are filtered through `isRepoAllowed()` which mirrors `filterRepos()`
semantics including the `SELF_REPO` exception. Triggering uses
`scheduler.triggerJob()` — jobs run their normal scan logic, just immediately
instead of waiting for the next poll interval. Webhooks supplement polling
(hybrid model), never replace it — if webhooks are misconfigured or down,
polling continues to work.

`configureWebhook()` in `github-app.ts` auto-sets the App's webhook URL
(`<externalUrl>/webhooks/github`) and secret on startup via
`PATCH /app/hook/config` (JWT auth). This is idempotent and logs a warning on
failure (polling still works without webhooks).

**`plan-parser.ts`** — Parses structured implementation plan comments into
discrete phases for multi-PR workflows. Exports the `PLAN_HEADER` constant
(`"## Implementation Plan"`) used by issue-refiner, plan-reviewer, and
issue-auditor to identify plan comments (centralized to eliminate duplicate
definitions). Looks for `### PR N:` or `### Phase N:` headers to split a plan
into phases. Also provides `findPlanComment()` to locate the most recent plan
comment in an issue's comment history (uses `includes` rather than `startsWith`
so it still matches when the Yeti visible header is prepended). Used by
issue-worker to implement multi-phase plans sequentially.

**`log.ts`** — Timestamped console logging with four levels: `debug`, `info`,
`warn`, `error`. Each level (except `error`) is gated by the `LOG_LEVEL` config
setting — messages below the configured threshold are suppressed from both
console output and DB capture. `error()` always executes regardless of level
(it triggers notifications). Errors also trigger notifications via `notify.ts`.
All log calls capture output into the `job_logs` table via
`AsyncLocalStorage`-based run context, so logs are associated with the job run
that produced them.

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

## Dashboard (`src/pages/`)

The web dashboard is a first-class consumer of job, config, and queue data. Page builders in `src/pages/` render HTML for the dashboard routes in `server.ts`. `layout.ts` exports a `siteTitle()` helper that builds page titles from `GITHUB_OWNERS` (e.g. "yeti — frostyard — Queue"), reading the config at call time for live-reload compatibility. Navigation: Dashboard → Jobs → Queue → Logs → Config. The Jobs page (`/jobs`) lists all known jobs with descriptions, enabled/disabled state, AI backend, model override, schedule, and Run/Pause controls. `createServer()` accepts a `JobInfo[]` array from `main.ts` so the Jobs page can show schedule info for all jobs (including disabled ones not registered with the scheduler). Any changes to config fields, job states, queue categories, or log/task schemas must be reflected in the corresponding page builders — the dashboard is not optional.
