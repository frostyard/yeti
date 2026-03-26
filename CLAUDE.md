# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Agent Planning

**superpowers planning docs** Save plans to .superpowers/plans instead of yeti/plans/
**superpowers spec docs** Save specs to .superpowers/specs/ instead of yeti/specs/

## Documentation

**update documentation** After any change to source code, update relevant documentation in CLAUDE.md, README.md and the yeti/ folder. A task is not complete without reviewing and updating relevant documentation.

**yeti/ directory** The `yeti/` directory contains documentation written for AI consumption and context enhancement, not primarily for humans. Jobs like `doc-maintainer` and `issue-worker` instruct the AI to read `yeti/OVERVIEW.md` and related files for codebase context before performing tasks. Write content in this directory to be maximally useful to an AI agent understanding the codebase — detailed architecture, patterns, and decision rationale rather than user-facing guides.

## Build & Run Commands

```sh
npm ci                  # install dependencies
npm run build           # compile TypeScript (tsc → dist/)
npm run typecheck       # type-check only, no emit (tsc --noEmit)
npm run dev             # run with tsx (development)
npm start               # run compiled output (node dist/main.ts)
npm test                # typecheck + run all tests (mirrors CI)
npm run test:watch      # run tests in watch mode (no typecheck, fast TDD)
npx vitest run src/scheduler.test.ts          # run a single test file
npx vitest run -t "returns ms until"          # run tests matching a name pattern
```

## Development

- **TDD** - Use TDD (test driven development) for all code changes
- **Worktrees** - Use git worktrees
- **Branching** - Before making any changes, create a branch. One branch per plan.
- **Dashboard awareness** — Any change to config fields, job behavior, queue categories, or status data must be reflected in the web dashboard (`src/server.ts` and `src/pages/`). Before considering a task complete, check whether the dashboard needs updates: new config fields need form controls in `src/pages/config.ts`, new job states or queue categories need display in `src/pages/dashboard.ts` or `src/pages/queue.ts`, and changes to log/task schemas need corresponding updates in `src/pages/logs.ts`.

## Architecture

Yeti is a self-hosted GitHub automation daemon that polls repositories on timers and delegates work to the `claude` CLI in isolated git worktrees. It runs as a systemd service on Linux (Node.js 22, ESM, strict TypeScript).

### Core modules

- **`main.ts`** — Entry point. Initializes SQLite DB, recovers orphaned tasks from prior crashes, registers ~10 jobs with the scheduler, starts the HTTP server, sets up live config reload and graceful shutdown (SIGINT/SIGTERM).
- **`scheduler.ts`** — Interval/daily-hour job runner with skip-if-busy semantics (no queue pile-up). Supports pause/resume, manual trigger, live interval updates.
- **`claude.ts`** — Multi-backend AI dispatch layer with bounded concurrent queues. Supports Claude CLI (default, 2 workers), Copilot CLI (separate queue, default 1 worker), and Codex CLI (separate queue, default 1 worker) via `AiBackend` type. `runAI()` is the backend-agnostic entry point used by all jobs; `resolveEnqueue()` selects the correct queue based on backend config. `runClaude()` remains as a legacy wrapper. Per-backend timeout with SIGTERM→SIGKILL escalation. Codex uses positional prompt (`promptVia: "positional"`). Also manages git worktree lifecycle (`createWorktree`/`removeWorktree`/`ensureClone`).
- **`github.ts`** — All GitHub interaction via `gh` CLI (never HTTP API directly). Exponential-backoff retry on transient errors, rate-limit circuit breaker (60s cooldown), TTL cache with in-flight dedup. Includes `scanQueueLabels()` — a lightweight label scanner that populates the dashboard queue cache independently of worker jobs. `clearSelfLogin()` resets the cached identity (used when switching to App auth).
- **`github-app.ts`** — Optional GitHub App authentication. Signs JWTs (RS256 via Node.js `crypto`), manages installation token lifecycle with 5-min pre-expiry refresh and in-flight dedup. Sets `process.env.GH_TOKEN` so all `gh`/`git` subprocesses inherit the App identity automatically. `configureWebhook()` auto-sets the App's webhook URL and secret on startup via `PATCH /app/hook/config` (JWT auth). Graceful fallback: if no App config, everything works via personal `gh` CLI auth.
- **`config.ts`** — Configuration priority: env vars > `~/.yeti/config.json` > defaults. Uses ESM `export let` for live reloads without restart. Exports `LABELS`, `INTERVALS`, `SCHEDULES`, `ALLOWED_REPOS`, `ENABLED_JOBS`, `JOB_AI`, `QUEUE_SCAN_INTERVAL_MS`, `REVIEW_LOOP`, `MAX_PLAN_ROUNDS`, `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `WEBHOOK_SECRET`, etc. Per-job AI backend/model overrides via `jobAi` config map. GitHub App and webhook fields are immutable (require restart).
- **`db.ts`** — SQLite (`~/.yeti/yeti.db`) with tables: `tasks`, `job_runs`, `job_logs`, `notifications`. Log capture via `AsyncLocalStorage` run context.
- **`oauth.ts`** — GitHub OAuth flow for dashboard sign-in. Handles authorization URL generation, code-for-token exchange, org membership verification, and HMAC-signed stateless session cookies (24h expiry). Zero dependencies beyond Node.js `crypto` and `fetch()`. Active when `githubAppClientId`, `githubAppClientSecret`, and `externalUrl` are all configured.
- **`webhooks.ts`** — GitHub webhook handler. Receives events via `POST /webhooks/github` with HMAC-SHA256 verification (`X-Hub-Signature-256`). Routes `issues.labeled`/`issues.unlabeled` to job triggers and queue cache updates, `check_run.completed` (failure/timed_out with PR association) to ci-fixer, `pull_request_review.submitted` (approved, on yeti/issue-*/yeti/improve-*/dependabot PRs) to auto-merger, and `pull_request.closed` to queue cache removal via `removeQueueItem`. Uses `scheduler.triggerJob()` — jobs run their normal scan logic, just triggered immediately. `isRepoAllowed()` mirrors `filterRepos()` semantics including `SELF_REPO` exception. Webhooks supplement polling (hybrid model), never replace it.
- **`server.ts`** — HTTP dashboard with job status, jobs detail page (`/jobs`), work queue, log viewer, config editor, notifications page (`/notifications`), SSE endpoint (`/notifications/stream`), webhook endpoint (`/webhooks/github`), and OAuth routes (`/auth/github`, `/auth/callback`, `/auth/logout`). Auth is enabled when `authToken` is set or OAuth is configured (either or both). `createServer(scheduler, allJobs)` accepts job metadata for the Jobs page. `closeSSEConnections()` is exported for graceful shutdown.
- **`error-reporter.ts`** — Deduplicating error reporter: logs + Discord + GitHub issues (`[yeti-error]`). 30-min cooldown per fingerprint. Filters `ShutdownError` and `RateLimitError`.
- **`discord.ts`** — Discord bot integration for notifications and job control commands. Uses discord.js. Supports GitHub commands: issue creation (`!yeti issue`), issue/PR analysis via Claude (`!yeti look`), labeling issues as Refined (`!yeti assign`), and listing items needing human attention (`!yeti for-me`). Repos are short names scoped to the configured GitHub org.
- **`notify.ts`** — Notification dispatcher. Exports `Notification` interface, `NotificationLevel` type, and `notificationEmitter` (EventEmitter). `notify(n: Notification)` persists to the `notifications` DB table, emits on `notificationEmitter` for SSE fan-out, and forwards to Discord.

### Jobs (`src/jobs/`)

Each job exports a `run()` function. Jobs discover work via comment analysis, reactions, labels, and PR state — not solely labels. Six labels exist: `Needs Refinement` (trigger for issue-refiner), `Needs Plan Review` (trigger for plan-reviewer), `Refined` (trigger for issue-worker), `Ready` (human decision needed), `In Review` (informational), `Priority` (queue ordering). Processed items are tracked via thumbsup reactions on comments.

When plan-reviewer is enabled, the workflow is human-in-the-loop: issue-refiner produces a plan → plan-reviewer critiques it → both land on the issue as comments with `Ready` label → a human reads the plan and critique, then either adds `Refined` to approve or posts feedback to trigger another refinement cycle. The adversarial review is for the human, not for automatic AI-to-AI refinement. When `reviewLoop` is enabled in config, plan-reviewer can send plans back to issue-refiner for automatic re-refinement (up to `maxPlanRounds` cycles, default 3) before falling through to human review. Plans with blocking clarifying questions (`### Clarifying Questions` or `### Clarifying Questions (blocking)`) skip review entirely and wait for human input; non-blocking questions (`### Clarifying Questions (non-blocking)`) proceed to review normally. `isPlanActionable()` in `plan-parser.ts` implements this check.

The `prompt-evaluator` job is a self-improvement mechanism: it reads the source of plan-producing prompts, generates improved variants via AI, A/B tests both against AI-generated realistic and adversarial synthetic issues, has AI judge the outputs, and files GitHub issues (labeled `prompt-improvement`) when the variant wins. Humans review and approve before any prompt change is applied.

Jobs must be listed in the `enabledJobs` config array to run. An empty or missing `enabledJobs` means no jobs start.

### Key patterns

- **Worktree isolation**: Each task gets `~/.yeti/worktrees/<owner>/<repo>/<job>/<branch>`, cleaned up in `finally` blocks.
- **Content-based state machine**: Issue/PR state is inferred from comments and reactions, not label-driven workflows. Exception: the issue-refiner requires the `Needs Refinement` label to produce a new plan (machine-generated `[ci-unrelated]` and `[yeti-error]` issues are exempt).
- **Two-phase identify/process**: Used by ci-fixer, improvement-identifier, issue-refiner — scan all items first, then process (prevents race conditions with concurrent GitHub API calls).
- **Crash recovery**: On startup, tasks still marked `running` in DB get their worktrees cleaned and are marked `failed`.
- **Tree-diff guard**: All PR-creating jobs gate on both `hasNewCommits` (commit count) and `hasTreeDiff` (actual tree difference via `git diff --quiet`) before pushing/creating PRs. This prevents failures when commits produce no effective changes.
- **Fresh duplicate-PR guard**: `getOpenPRForIssue` bypasses the `listPRs` TTL cache (`fresh: true`) to avoid race conditions where a concurrent PR is invisible during the 60-second cache window.

## Testing

Tests are co-located (`*.test.ts` next to source). Heavy mocking of external boundaries (`gh` CLI, `claude` CLI, filesystem). Use `vi.mock()` at module level. Test helpers in `src/test-helpers.ts` provide `mockRepo()`, `mockIssue()`, `mockPR()` factories.

## Deployment

- Deployed to `/opt/yeti` via systemd (`deploy/yeti.service`)
- Auto-updates via `yeti-updater.timer` checking GitHub releases every 60s
- Version tags: `v<YYYY-MM-DD>.<N>` — release workflow on push to `main`
- Release tarball: `dist/` + `deploy/` + `node_modules/`
- Health check: `GET /health` on port 9384

## Cross-Cutting Concerns

After any change to `src/config.ts` (new config fields, removed fields, env var changes), update both `deploy/install.sh` **and** `src/pages/config.ts`.

After any change to job behavior or queue categories, review `src/pages/dashboard.ts` and `src/pages/queue.ts`.

After adding or changing API routes in `src/server.ts`, ensure corresponding page builders in `src/pages/` are updated.

Also review `deploy/deploy.sh` if the deployment lifecycle changes.
