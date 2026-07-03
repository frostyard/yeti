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
npm ci                  # install dependencies (includes the web/ SPA toolchain, dev-only)
npm run build           # compile daemon (tsc → dist/) AND build the SPA (vite → dist/public/)
npm run build:server    # compile only the daemon (tsc)
npm run build:web       # build only the SPA (vite → dist/public/)
npm run typecheck       # type-check the daemon (tsc --noEmit)
npm run typecheck:web   # type-check the SPA (tsc -p web/tsconfig.json)
npm run dev             # run the daemon with tsx (development)
npm run dev:web         # Vite dev server on :5173, proxying /api,/auth,/webhooks,/health → :9384
npm start               # run compiled output (node dist/main.js), serves dist/public
npm test                # typecheck (daemon + web) + run all tests (mirrors CI)
npm run test:watch      # run tests in watch mode (no typecheck, fast TDD)
npx vitest run src/scheduler.test.ts          # run a single daemon test file
npx vitest run --project web                  # run only the SPA (jsdom) tests
npx vitest run -t "returns ms until"          # run tests matching a name pattern
```

**Local UI development**: run `npm run dev` (daemon on :9384) and `npm run dev:web` (Vite on :5173) together; open :5173. The daemon must have `initDb()`'d state and jobs registered. `vitest.config.ts` defines two projects: `server` (node, `src/**`) and `web` (jsdom, `web/**`).

## Development

- **TDD** - Use TDD (test driven development) for all code changes
- **Worktrees** - Use git worktrees
- **Branching** - Before making any changes, create a branch. One branch per plan.
- **Dashboard awareness** — The dashboard is a React + Vite SPA in `web/` served by the daemon; the daemon exposes data over a JSON API in `src/api.ts` and serves the built SPA via `src/static.ts`. Any change to config fields, job behavior, queue categories, or status data must be reflected in **both** the API (`src/api.ts` — add/extend the relevant `/api/*` payload) and the SPA (`web/src/` — the matching route in `web/src/routes/` and the shared types in `web/src/lib/types.ts`). New config fields need form controls in `web/src/routes/Config.tsx` **and** validation/whitelisting in `buildConfigUpdate()` in `src/api.ts`; new job states or queue categories need display in `web/src/routes/Jobs.tsx` / `web/src/routes/Queue.tsx` (and `web/src/lib/categories.ts`); log/task schema changes need updates in `web/src/routes/Logs.tsx`/`LogDetail.tsx`/`IssueLogs.tsx`.

## Architecture

Yeti is a self-hosted GitHub automation daemon that polls repositories on timers and delegates work to the `claude` CLI in isolated git worktrees. It runs as a systemd service on Linux (Node.js 22, ESM, strict TypeScript).

### Core modules

- **`main.ts`** — Entry point. Initializes SQLite DB, recovers orphaned tasks from prior crashes, registers ~10 jobs with the scheduler, starts the HTTP server, sets up live config reload and graceful shutdown (SIGINT/SIGTERM).
- **`scheduler.ts`** — Interval/daily-hour job runner with skip-if-busy semantics (no queue pile-up). Supports pause/resume, manual trigger, live interval updates.
- **`claude.ts`** — Multi-backend AI dispatch layer with bounded concurrent queues. Supports Claude CLI (default, 2 workers), Copilot CLI (separate queue, default 1 worker), and Codex CLI (separate queue, default 1 worker) via `AiBackend` type. `runAI()` is the backend-agnostic entry point used by all jobs; `resolveEnqueue()` selects the correct queue based on backend config. `runClaude()` remains as a legacy wrapper. Per-backend timeout with SIGTERM→SIGKILL escalation. Codex uses positional prompt (`promptVia: "positional"`). Also manages git worktree lifecycle (`createWorktree`/`removeWorktree`/`ensureClone`).
- **`github.ts`** — All GitHub interaction via `gh` CLI (never HTTP API directly). Exponential-backoff retry on transient errors, rate-limit circuit breaker (60s cooldown), TTL cache with in-flight dedup. Includes `scanQueueLabels()` — a lightweight label scanner that populates the dashboard queue cache independently of worker jobs. `setSelfLogin()` sets the cached identity (used by GitHub App auth to inject the App login).
- **`github-app.ts`** — Optional GitHub App authentication. Signs JWTs (RS256 via Node.js `crypto`), manages installation token lifecycle with 5-min pre-expiry refresh and in-flight dedup. Sets `process.env.GH_TOKEN` so all `gh`/`git` subprocesses inherit the App identity automatically. `configureWebhook()` auto-sets the App's webhook URL and secret on startup via `PATCH /app/hook/config` (JWT auth). Graceful fallback: if no App config, everything works via personal `gh` CLI auth.
- **`config.ts`** — Configuration priority: env vars > `~/.yeti/config.json` > defaults. Uses ESM `export let` for live reloads without restart; `watchConfig()` live-reloads external `config.json` edits as well as in-app writes. Exports `LABELS`, `INTERVALS`, `SCHEDULES`, `ALLOWED_REPOS`, `ENABLED_JOBS`, `JOB_AI`, `QUEUE_SCAN_INTERVAL_MS`, `REVIEW_LOOP`, `MAX_PLAN_ROUNDS`, `LEARNINGS_PENDING_THRESHOLD`, `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `WEBHOOK_SECRET`, etc. Per-job AI backend/model overrides via `jobAi` config map. GitHub App and webhook fields are immutable (require restart).
- **`db.ts`** — SQLite (`~/.yeti/yeti.db`) with tables: `tasks`, `job_runs`, `job_logs`, `notifications`, `learnings`. Log capture via `AsyncLocalStorage` run context.
- **`oauth.ts`** — GitHub OAuth flow for dashboard sign-in. Handles authorization URL generation, code-for-token exchange, org membership verification, and HMAC-signed stateless session cookies (24h expiry). Zero dependencies beyond Node.js `crypto` and `fetch()`. Active when `githubAppClientId`, `githubAppClientSecret`, and `externalUrl` are all configured.
- **`webhooks.ts`** — GitHub webhook handler. Receives events via `POST /webhooks/github` with HMAC-SHA256 verification (`X-Hub-Signature-256`). Routes `issues.labeled`/`issues.unlabeled` to job triggers and queue cache updates, `issue_comment.created` to issue-refiner for plain issue comments or review-addresser for PR conversation comments, `pull_request_review_comment.created` to review-addresser, `check_run.completed` (failure/timed_out with PR association) to ci-fixer, `pull_request_review.submitted` (approved, on yeti/issue-*/yeti/improve-*/dependabot PRs) to auto-merger, and `pull_request.closed` to queue cache removal via `removeQueueItem`. Comment routes ignore Yeti's own login from `getSelfLogin()` and any `[bot]` author. Uses `scheduler.triggerJob()` — jobs run their normal scan logic, just triggered immediately. `isRepoAllowed()` mirrors `filterRepos()` semantics including `SELF_REPO` exception. Webhooks supplement polling (hybrid model), never replace it.
- **`server.ts`** — HTTP entrypoint. Serves the webhook endpoint (`/webhooks/github`), the notification SSE stream (`/api/notifications/stream`), OAuth routes (`/auth/github`, `/auth/callback`, `/auth/logout`), `GET /health`, delegates everything under `/api/*` to `handleApi` (`src/api.ts`), and finally serves the built SPA + client-side-routing fallback via `src/static.ts`. Auth is enabled when `authToken` is set or OAuth is configured (either or both). `createServer(scheduler, allJobs)` accepts job metadata for `/api/jobs`. `closeSSEConnections()` is exported for graceful shutdown.
- **`api.ts`** — JSON API for the SPA. `handleApi()` routes `/api/*`: `GET /api/session` (auth probe, never 401s), `GET /api/overview|jobs|queue|runs|runs/:id|runs/:id/tail|runs/issue|notifications|config|repos`, and `POST /api/login|logout|jobs/:name/{trigger,pause}|tasks/cancel|queue/{merge,skip,unskip,prioritize,deprioritize}|repos|config`. `requireApiAuth` (from `src/http-util.ts`) returns JSON 401 (not an HTML redirect). Maps (`getLogsForRuns`/`getWorkItemsForRuns`) are flattened to objects before serialization.
- **`sysstats.ts`** — Dependency-free host health snapshot (CPU % via `os.cpus()` deltas, load average, memory used/total, disk via `fs.statfsSync`). Surfaced in `GET /api/overview` as `system` and rendered as the Overview "System" cards.
- **`static.ts`** — Dependency-free static file server for the built SPA (`dist/public`). Hashed `/assets/*` are cached `immutable`; `index.html` is `no-cache` (deploys hot-swap bundles); unknown non-asset GET paths fall back to `index.html` for client-side routing; missing assets 404.
- **`http-util.ts`** — Shared cookie/body parsing, `safeCompare`, `getSession`, and `requireApiAuth`. **`format.ts`** / **`job-meta.ts`** — pure formatting helpers and `JobInfo`/`JOB_DESCRIPTIONS`, shared by the API and the SPA (ported into `web/src/lib/format.ts`).
- **`error-reporter.ts`** — Deduplicating error reporter: logs + Discord + GitHub issues (`[yeti-error]`). 30-min cooldown per fingerprint. Filters `ShutdownError` and `RateLimitError`.
- **`learnings.ts`** — Self-improvement loop gate. The shared preamble mandates every agent session end with a `LEARNINGS-REPO:` / `LEARNINGS-YETI:` declaration. `enforceLearnings()` runs after the main `runAI` call in work jobs (issue-worker, ci-fixer, review-addresser, improvement-identifier): missing declaration → one retry in the same worktree; claimed repo learnings are verified against a `yeti/` pathspec tree-diff; environment learnings are persisted to the `learnings` table and, at `learningsPendingThreshold` pending (default 5), trigger the learning-consolidator job. The gate never fails a task. `stripLearningsDeclaration()` removes declaration lines from AI output posted to GitHub (plans, reviews, reports, comments).
- **`discord.ts`** — Discord bot integration for notifications and job control commands. Uses discord.js. Supports GitHub commands: issue creation (`!yeti issue`), issue/PR analysis via Claude (`!yeti look`), labeling issues as Refined (`!yeti assign`), and listing items needing human attention (`!yeti for-me`). Repos are short names scoped to the configured GitHub org.
- **`notify.ts`** — Notification dispatcher. Exports `Notification` interface, `NotificationLevel` type, and `notificationEmitter` (EventEmitter). `notify(n: Notification)` persists to the `notifications` DB table, emits on `notificationEmitter` for SSE fan-out, and forwards to Discord.

### Jobs (`src/jobs/`)

Each job exports a `run()` function. Jobs discover work via comment analysis, reactions, labels, and PR state — not solely labels. Six labels exist: `Needs Refinement` (trigger for issue-refiner), `Needs Plan Review` (trigger for plan-reviewer), `Refined` (trigger for issue-worker), `Ready` (human decision needed), `In Review` (informational), `Priority` (queue ordering). Processed items are tracked via thumbsup reactions on comments.

When plan-reviewer is enabled, the workflow is human-in-the-loop: issue-refiner produces a plan → plan-reviewer critiques it → both land on the issue as comments with `Ready` label → a human reads the plan and critique, then either adds `Refined` to approve or posts feedback to trigger another refinement cycle. The adversarial review is for the human, not for automatic AI-to-AI refinement. When `reviewLoop` is enabled in config, the loop converges autonomously: plan-reviewer reviews with full thread context under a Blocking/Advisory contract (`src/review-contract.ts` — verdict is mechanical: zero Blocking findings → APPROVED). NEEDS REVISION kicks the issue back with `Needs Refinement`; issue-refiner routes reviewer kickbacks to a targeted revision (`issue-refiner.revise.md` — findings dispositioned by ID, plan edited in place, `### Review Response` posted separately) rather than a from-scratch replan. Review dedup is a `<!-- yeti-review-of:id:updatedAt -->` marker (identity-independent, re-arms on plan edits). Round budget (`maxPlanRounds`, default 3) counts reviews since the last human comment; at the cap the issue falls through to `Ready` for human review. Human feedback always outranks the loop and resets the round budget. Plans with blocking clarifying questions (`### Clarifying Questions` or `### Clarifying Questions (blocking)`) skip review entirely and wait for human input; non-blocking questions (`### Clarifying Questions (non-blocking)`) proceed to review normally. `isPlanActionable()` in `plan-parser.ts` implements this check.

The `prompt-evaluator` job is a self-improvement mechanism: it reads the source of plan-producing prompts, generates improved variants via AI, A/B tests both against AI-generated realistic and adversarial synthetic issues, has AI judge the outputs, and files GitHub issues (labeled `prompt-improvement`) when the variant wins. Humans review and approve before any prompt change is applied.

The `learning-consolidator` job closes the yeti-side self-improvement loop: agents declare environment/tooling friction (`LEARNINGS-YETI:`) during work sessions; the gate persists it; this job (daily at `learningConsolidatorHour`, or when the pending count reaches `learningsPendingThreshold`) runs one AI pass in a SELF_REPO worktree to fold pending learnings into `_preamble.md` / job policies / `yeti/` docs and opens a PR. Humans merge; the release flow deploys; every future prompt includes the learning. Repo-side learnings never reach yeti: agents commit them as `yeti/learnings/<slug>.md` files in the target repo's PR, and doc-maintainer later folds those seeds into topic docs.

Jobs must be listed in the `enabledJobs` config array to run. An empty or missing `enabledJobs` means no jobs start.

### Key patterns

- **Worktree isolation**: Each task gets `~/.yeti/worktrees/<owner>/<repo>/<job>/<branch>`, cleaned up in `finally` blocks.
- **Content-based state machine**: Issue/PR state is inferred from comments and reactions, not label-driven workflows. Exception: the issue-refiner requires the `Needs Refinement` label to produce a new plan (machine-generated `[ci-unrelated]` and `[yeti-error]` issues are exempt).
- **Two-phase identify/process**: Used by ci-fixer, improvement-identifier, issue-refiner — scan all items first, then process (prevents race conditions with concurrent GitHub API calls).
- **Crash recovery**: On startup, tasks still marked `running` in DB get their worktrees cleaned and are marked `failed`.
- **Tree-diff guard**: All PR-creating jobs gate on both `hasNewCommits` (commit count) and `hasTreeDiff` (actual tree difference via `git diff --quiet`) before pushing/creating PRs. This prevents failures when commits produce no effective changes.
- **Fresh duplicate-PR guard**: `getOpenPRForIssue` bypasses the `listPRs` TTL cache (`fresh: true`) to avoid race conditions where a concurrent PR is invisible during the 60-second cache window.
- **Prompt policies + shared preamble**: Job prompts are `src/policies/<job>.md` templates rendered by `renderPolicy()` (`src/policy.ts`) with `${VAR}` substitution and per-autonomy variants; user overrides live in `~/.yeti/policies`. `src/policies/_preamble.md` is prepended to **every** rendered prompt — the DRY place for environment-wide agent guidance (e.g. "install tools with `brew`, never `apt`/`sudo`"). Backends run without an internal sandbox (Claude `--dangerously-skip-permissions`, Codex `--sandbox danger-full-access`), so agents can install via Homebrew, which must be on the runtime user's login-shell PATH.
- **Self-improvement loop**: every work session must produce the work AND the learning. Enforced mechanically by `src/learnings.ts` (see Core modules) rather than by prompt diligence alone.

## Testing

Tests are co-located (`*.test.ts` next to source). Heavy mocking of external boundaries (`gh` CLI, `claude` CLI, filesystem). Use `vi.mock()` at module level. Test helpers in `src/test-helpers.ts` provide `mockRepo()`, `mockIssue()`, `mockPR()` factories.

## Deployment

- Deployed to `/opt/yeti` via systemd (`deploy/yeti.service`)
- Auto-updates via `yeti-updater.timer` checking GitHub releases every 60s
- Version tags: `v<YYYY-MM-DD>.<N>` — release workflow on push to `main`
- Release tarball: `dist/` + `deploy/` + `node_modules/`
- Health check: `GET /health` on port 9384 — returns `{status, version, activeTasks, updatePending}`; `activeTasks` is the deploy drain signal.
- **Graceful updates (quiesce)**: when `deploy.sh` sees a newer release it writes a `~/.yeti/quiesce` sentinel (via `src/quiesce.ts`), then polls `/health` until `activeTasks === 0` (bounded by `UPDATE_MAX_WAIT`, default 1800s) before stopping the service — so an update never kills a long in-flight AI run mid-commit. While the sentinel exists the scheduler defers new job runs and `triggerJob` returns `"update-pending"`; the daemon clears it on startup, and the dashboard shows an "update pending" banner. After the cap, deploy proceeds anyway (the service-stop drain, `TimeoutStopSec=330`, bounds the rest).

## Cross-Cutting Concerns

After any change to `src/config.ts` (new config fields, removed fields, env var changes), update `deploy/install.sh`, the `buildConfigUpdate()` whitelist in `src/api.ts`, **and** the config form in `web/src/routes/Config.tsx`.

After any change to job behavior or queue categories, review the `/api/jobs` and `/api/queue` payloads in `src/api.ts` and the matching routes in `web/src/routes/` (`Jobs.tsx`, `Queue.tsx`, `Overview.tsx`) plus `web/src/lib/categories.ts`.

After adding or changing API routes in `src/api.ts`, update the typed client in `web/src/lib/api.ts`, the response types in `web/src/lib/types.ts`, and the query hooks in `web/src/lib/queries.ts`.

Also review `deploy/deploy.sh` if the deployment lifecycle changes.
