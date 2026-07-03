# Yeti — Overview

Yeti is a self-hosted
GitHub automation service. It polls GitHub repositories on configurable timers
(and optionally receives GitHub webhooks for near-real-time triggers),
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
├── webhooks.ts          GitHub webhook handler — HMAC verification, event routing, queue cache updates
├── error-reporter.ts    Deduplicating GitHub issue-based error reporter (filters ShutdownError, RateLimitError)
├── learnings.ts         Self-improvement loop gate (enforceLearnings), declaration parser, consolidator trigger
├── images.ts            Image/attachment extraction + download for issue/PR context
├── update-check.ts      Manual dashboard-triggered update-check sentinel
├── version.ts           Build-time injected version string
├── plan-parser.ts       Parses multi-PR implementation plans into phases; exports PLAN_HEADER constant
├── review-contract.ts   Shared review protocol: review marker dedup, verdict parse/render, round counting (used by plan-reviewer and issue-refiner)
├── startup-announce.ts  Announces new deployments via notify (version-change detection)
├── shutdown.ts          Graceful shutdown flag + ShutdownError class (shared across modules)
├── test-helpers.ts      Test factories (mockRepo, mockIssue, mockPR)
├── pages/
│   ├── dashboard.ts     Main status page HTML builder
│   ├── jobs.ts          Jobs page HTML builder (all jobs with backend/model/schedule)
│   ├── repos.ts         Repos page HTML builder (per-repo active/completed items, add repo dialog)
│   ├── queue.ts         Work queue page HTML builder
│   ├── logs.ts          Log list, detail, and issue logs page HTML builders
│   ├── config.ts        Config editor page HTML builder (tabbed: General, Scheduling, AI, Integrations, Security)
│   ├── login.ts         Login page HTML builder
│   ├── notifications.ts Notifications page HTML builder (recent notification history)
│   └── layout.ts        Shared layout (header, theme, siteTitle, formatters, TOAST_SCRIPT)
└── jobs/
    ├── issue-refiner.ts        Discovers issues needing plans via comment analysis
    ├── plan-reviewer.ts        Adversarial plan review with thread context; Blocking/Advisory verdict contract
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
    ├── prompt-evaluator.ts     Weekly self-improvement: A/B tests prompts, files issues for winners
    └── learning-consolidator.ts  Daily/threshold-triggered: folds pending environment learnings into policies/docs via PR

scripts/
└── ab-agent-test.sh       A/B test harness comparing AI backends (Claude vs Codex) on real issues

deploy/
├── yeti.service           systemd service unit
├── yeti-updater.service   systemd updater service
├── yeti-updater.timer     systemd timer (hourly)
├── yeti-updater-trigger.path  systemd path unit for manual update checks
├── install.sh              One-shot bootstrap installer (repo-aware)
├── deploy.sh               Auto-update with health check + rollback (repo-aware)
└── uninstall.sh            Service removal
```

### Module Responsibilities

See [Modules](modules.md) for detailed descriptions of each module. Key relationships:

- **`main.ts`** wires everything: DB init, crash recovery, job registration, config reload, graceful shutdown
- **`config.ts`** loads config (env > config.json > defaults); exports `LABELS`, `INTERVALS`, `SCHEDULES`, `ENABLED_JOBS`
- **`capability.ts`** enforces autonomy tiers (`advisory` → `issues` → `pr` → `automerge`) for comment/issue/PR/push/merge actions
- **`scheduler.ts`** runs jobs on intervals or daily schedules with skip-if-busy semantics
- **`github.ts`** wraps `gh` CLI with retry, rate-limit circuit breaker, TTL cache, and queue cache
- **`github-app.ts`** optional GitHub App auth (JWT signing, installation tokens, `GH_TOKEN` injection)
- **`oauth.ts`** optional GitHub OAuth for dashboard sign-in (stateless HMAC cookies, org membership check)
- **`claude.ts`** multi-backend AI dispatch (3 bounded queues) + git worktree helpers
- **`db.ts`** SQLite with `tasks`, `job_runs`, `job_logs`, `notifications` tables — see [Database Schema](database-schema.md)
- **`server.ts`** HTTP dashboard + API routes + webhook endpoint + SSE notifications stream
- **`webhooks.ts`** GitHub webhook handler (HMAC-verified, routes issues/check_run/comment/pull_request_review/pull_request events to job triggers, auto-merger triggering, and queue cache updates)
- **`log.ts`** level-gated logging captured to DB via `AsyncLocalStorage`
- **`error-reporter.ts`** deduplicating error reporter (GitHub issues + Discord, 30-min cooldown)
- **`learnings.ts`** self-improvement loop gate (`enforceLearnings()`, `stripLearningsDeclaration()`) — persists environment learnings to the `learnings` table and triggers `learning-consolidator.ts`; see [Modules](modules.md) and the "Self-Improvement Loop" section below
- **`images.ts`** extracts/downloads images and file attachments for AI context
- **`update-check.ts`** writes the manual update-check sentinel consumed by the systemd path unit
- **`plan-parser.ts`** parses multi-PR implementation plans into phases; exports shared `PLAN_HEADER` constant
- **`notify.ts`** / **`discord.ts`** notification dispatch (DB + SSE + Discord) and Discord bot commands
- **`startup-announce.ts`** announces new deployments; **`shutdown.ts`** shared shutdown flag

### Dashboard (`src/pages/`)

The web dashboard is a first-class consumer of job, config, and queue data. Page builders in `src/pages/` render HTML for the dashboard routes in `server.ts`. `layout.ts` exports a `siteTitle()` helper that builds page titles from `GITHUB_OWNERS` (e.g. "yeti — frostyard — Queue"), reading the config at call time for live-reload compatibility. It also exports `TOAST_SCRIPT` — client-side JavaScript that connects to the `/notifications/stream` SSE endpoint and renders incoming notifications as auto-dismissing toast popups on every dashboard page. Navigation: Dashboard → Jobs → Queue → Logs → Config → Notifications. The Jobs page (`/jobs`) lists all known jobs with descriptions, enabled/disabled state, AI backend, model override, schedule, and Run/Pause controls. `createServer()` accepts a `JobInfo[]` array from `main.ts` so the Jobs page can show schedule info for all jobs (including disabled ones not registered with the scheduler). Any changes to config fields, job states, queue categories, or log/task schemas must be reflected in the corresponding page builders — the dashboard is not optional.

## Jobs

Fourteen scheduled jobs run on timers or schedules.
See [Jobs](jobs.md) for detailed behavior of each.

| Job | Trigger | Interval | Summary |
|-----|---------|----------|---------|
| `issue-refiner` | Issues labelled `Needs Refinement` | 5 min | Posts implementation plans using a four-step prompt (evaluate plannability with phantom reference detection → draft plan with anti-gold-plating checklist → two rounds of self-critique against five dimensions: unverified assumptions, scope discipline, ordering correctness, risk honesty, and completeness vs. gold-plating → produce final revised plan); asks clarifying questions for underspecified issues using blocking/non-blocking classification; gates review on plan actionability (blocking questions skip review and wait for human input); enforces anti-scope-creep and narrowest-interpretation guards; refines plans via structured prompt (grounded file reads, per-comment processing, scope guard, conflict flagging, post-revision verification); responds to follow-up questions on issues with open PRs |
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
| `learning-consolidator` | Daily at 6 AM, or when pending learnings reach `learningsPendingThreshold` | Scheduled + threshold trigger | Folds pending environment learnings into `_preamble.md` / job policies / `yeti/` docs, opens a PR against `SELF_REPO` |

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
  Needs Refinement label →  (refiner posts plan)         →  Needs Plan Review added (if plan-reviewer enabled and plan actionable) or Ready added (if actionable) or no label (if blocking questions — waits for human)
  Needs Plan Review label → (plan-reviewer critiques)    →  Ready added (default, or reviewLoop off) or Needs Refinement (if reviewLoop on + NEEDS REVISION + under maxPlanRounds) or Ready + warning comment (if reviewLoop on + at maxPlanRounds)
  Unreacted feedback     →  (refiner refines plan)       →  Needs Plan Review or Ready (if actionable) or no label (if blocking questions)
  Open PR + follow-up Q  →  (refiner posts response)     →  👍 reactions added (no label changes)
  Refined label          →  (worker creates PR)          →  Refined removed, Ready removed, In Review added
  [yeti-error] title    →  (triage-yeti-errors)        →  investigation report posted

PRs:
  Unreacted review comments  →  (review-addresser)  →  👍 reactions added, Ready added
  Dependabot or LGTM'd Yeti PR + passing CI  →  (auto-merger)  →  merged, In Review removed
  Doc PR (yeti/docs-*) + doc-only files + CI passing/skipped  →  (auto-merger)  →  merged (no LGTM required)
```

With `reviewLoop` on, a rejected plan converges autonomously without human
intervention: `NEEDS REVISION → Needs Refinement → (issue-refiner revises the
plan in place via processReviewRevision) → Needs Plan Review → …` repeating
until either `APPROVED → Ready` or the round budget (`maxPlanRounds`, counted
since the most recent human comment) is exhausted, at which point the issue
falls through to `Ready` with a warning comment for human review. A human
comment posted at any point outranks the loop: issue-refiner routes it to a
full refinement pass (absorbing any pending review into the same revision)
and resets the round count.

Jobs track processed items via 👍 reactions on comments (issue-refiner,
review-addresser) and by checking for existing report comments (triage jobs).
Plan-review dedup uses an invisible `<!-- yeti-review-of:id:updatedAt -->`
marker rather than reactions — see the `review-contract.ts` entry in
[Modules](modules.md).
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

Backends with zero workers are treated as disabled. `enqueue()` and
`enqueueCodex()` reject immediately when their worker count is `0`, and startup
plus config reload log warnings for enabled jobs that resolve to any backend
with zero workers. Tests that need a pending queue item should keep one worker
busy with a blocking promise; setting a worker count to `0` exercises the
disabled-backend path instead.

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
"Could not resolve to a", "TLS handshake timeout", "Something went wrong",
"stream error" — HTTP/2 stream cancellations, "unexpected EOF" — connection
drops mid-response).
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

The ci-fixer identifies all PR work first, then processes typed work items
(`conflict`, `rerun`, `unrelated`, `fix`). Unrelated failures are grouped into
one consolidated `[ci-unrelated]` issue per repo to avoid duplicate issue races,
and `[ci-unrelated]` fix PRs skip classification so they do not loop on the
same pre-existing failures. Prior ci-fixer fix commits are reverted
deterministically from `tasks.commit_shas`; AI is only used when a clean
in-code revert conflicts.

### Autonomy Tiers

Each repo resolves an autonomy tier from `autonomy[owner/repo]` or
`defaultAutonomy` (default `pr`). The tier is both a policy selector and an
enforcement boundary:

| Tier | Allows |
|------|--------|
| `advisory` | comments, labels, reactions |
| `issues` | advisory actions plus issue creation |
| `pr` | issues tier plus branch pushes and PR creation |
| `automerge` | pr tier plus merging |

Jobs perform pre-flight `can(repo, action)` checks before starting work that
would exceed the repo's tier, and `assertCapability(fullName, action)` acts as
a lower-level firewall. Autonomy denials are expected control flow:
`AutonomyError` is logged and suppressed by the error reporter rather than
opening `[yeti-error]` issues.

The dashboard annotates queue items that look pending but cannot currently run
because of autonomy. `refined` requires `createPR` (`pr` tier),
`needs-review-addressing` requires `push` (`pr` tier), and `auto-mergeable`
requires `merge` (`automerge` tier). Advisory-only categories are never marked
tier-blocked.

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

### Self-Improvement Loop

General-purpose AI jobs must end with `LEARNINGS-REPO:` and `LEARNINGS-YETI:`
declarations. `enforceLearnings()` retries once if the declaration is missing,
persists environment learnings to the `learnings` table, and lets
`learning-consolidator` fold them into policies/docs. Repo learnings are
committed into the target repo as `yeti/learnings/<slug>.md` seeds; later
`doc-maintainer` runs fold those seeds into durable topic docs and delete them.

A user override at `~/.yeti/policies/_preamble.md` shadows the bundled
`src/policies/_preamble.md` entirely; it does not merge. Operators with a
custom preamble must copy the self-improvement mandate into the override.

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

### Git Identity for Direct Commits

All jobs normally commit via `runAI()`, which delegates to the Claude/Copilot/Codex
CLI — these handle git identity internally. Direct in-code git commits must
pass inline identity flags because the `yeti` system user has no global git
config:
`git -c user.email=yeti@users.noreply.github.com -c user.name=Yeti commit ...`.
`doc-maintainer` uses this for the direct `CLAUDE.md` doc-block commit, and
ci-fixer uses the same identity for deterministic `git revert --no-edit`
commits.

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
| `schedules.learningConsolidatorHour` | — | `6` (6 AM local time) |
| `logLevel` | `YETI_LOG_LEVEL` | `"debug"` (debug, info, warn, error) |
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
| `defaultAutonomy` | — | `"pr"` (default autonomy tier for repos not listed in `autonomy`) |
| `autonomy` | — | `{}` (per-repo `owner/repo` autonomy overrides; dashboard saves replace the whole map) |
| `authToken` | `YETI_AUTH_TOKEN` | *(empty — auth disabled)* |
| `githubAppClientId` | `YETI_GITHUB_APP_CLIENT_ID` | *(empty — OAuth disabled)* |
| `githubAppClientSecret` | `YETI_GITHUB_APP_CLIENT_SECRET` | *(empty — OAuth disabled)* |
| `externalUrl` | `YETI_EXTERNAL_URL` | *(empty — OAuth disabled; must start with http:// or https://)* |
| `webhookSecret` | `YETI_WEBHOOK_SECRET` | *(empty — webhooks disabled; auto-configured when GitHub App + externalUrl are set)* |
| `pausedJobs` | — | `[]` (job names to pause on startup) |
| `enabledJobs` | — | `[]` (job names to register with the scheduler; empty = no jobs run) |
| `skippedItems` | — | `[]` (array of `{repo, number}` excluded from processing) |
| `allowedRepos` | `YETI_ALLOWED_REPOS` | `null` (all repos) |
| `prioritizedItems` | — | `[]` (array of `{repo, number}` processed first) |
| `queueScanIntervalMs` | — | `300000` (5 min — how often the dashboard queue refreshes from GitHub labels; infrastructure, always runs) |
| `reviewLoop` | — | `false` (when true, a NEEDS REVISION verdict kicks the plan back to issue-refiner for a targeted in-place revision, converging autonomously without a human in the loop) |
| `maxPlanRounds` | — | `3` (max plan→review cycles counted since the most recent human comment; a human comment resets the count; at the cap the issue falls through to `Ready` for human review; minimum 1) |
| `learningsPendingThreshold` | — | `5` (pending environment learnings that immediately trigger learning-consolidator; minimum 1) |

### enabledJobs

Controls which jobs are registered with the scheduler at startup; empty or
missing means no worker jobs start. It is live-reloadable. The declaration half
of the self-improvement loop is baked into work jobs, but
`learning-consolidator` must also be listed here for pending environment
learnings to be folded into policies/docs.

### allowedRepos

Restricts `listRepos()` by short repo name. `null` means all discovered repos;
`[]` means only `selfRepo`; explicit entries are case-insensitive and
`selfRepo` is always included. The dashboard config UI maps an empty input to
`[]`, not `null`; remove the key from `config.json` to restore all repos.

### includeForks

When false, Yeti discovers only source repos via `gh repo list --source`. When
true, forks are included in both worker discovery and the Repos onboarding
page; PRs created on forks target the fork, not the upstream parent.

Config changes made via the web UI (`POST /config`) and external edits to
`~/.yeti/config.json` take effect immediately at runtime — no restart required.
The config module uses ESM live bindings (`export let`) so all consumers see
updated values on their next access. `writeConfig()` reloads after in-app
writes, and `watchConfig()` uses a debounced `fs.watch` on the config file's
directory so hand-edits and config-management pushes also call
`reloadConfig()` and `onConfigChange()` listeners. Interval and schedule
changes are propagated to the scheduler via listeners that call
`updateInterval()` / `updateScheduledHour()`. The only exception is `port`
(requires socket re-bind), which is shown as read-only in the UI.

`writeConfig()` deep-merges only `intervals`, `schedules`, and `jobAi`; all
other object fields are replaced as whole values. `autonomy` deliberately
stays out of the deep-merge list because dashboard saves submit the complete
per-repo map and must be able to remove overrides by writing `{}`.

`config.ts` must not import `log.ts`: `log.ts` reads config live bindings such
as `LOG_LEVEL`, so importing the logger from config would create a circular
dependency during module initialization. Diagnostics in config loading and
watching use `console.warn` / `console.error`, or logging happens from callers
that listen for config changes.

Env vars always take priority over `config.json`. Fields set via env var
are shown as disabled in the config UI with a note indicating the override.

External tools `gh` and `claude` must be authenticated separately — Yeti does
not manage their credentials.

The Discord integration requires creating a Discord application, bot token, and private channel. See
[Discord Setup](discord-setup.md) for the full walkthrough.

## Technology Stack & Deployment

Yeti is Node.js 22 + strict TypeScript ESM, backed by SQLite via
better-sqlite3, tested with Vitest, and released as date-tagged tarballs.
GitHub Actions build/test on every push. See [Deployment](deployment.md) for
systemd update mechanics, self-describing release tarballs, multi-instance
behavior, and runtime filesystem layout. See [Future Yeti — Vision](VISION.md)
for the longer-term orchestrator direction.
