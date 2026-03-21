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
npm run dev             # run with tsx (development)
npm start               # run compiled output (node dist/main.ts)
npm test                # run all tests (vitest run)
npm run test:watch      # run tests in watch mode
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
- **`claude.ts`** — Multi-backend AI dispatch layer with bounded concurrent queues. Supports Claude CLI (default, 2 workers) and Copilot CLI (separate queue, default 1 worker) via `AiBackend` type. `runAI()` is the backend-agnostic entry point; `runClaude()` remains as a thin wrapper. Per-backend timeout with SIGTERM→SIGKILL escalation. Also manages git worktree lifecycle (`createWorktree`/`removeWorktree`/`ensureClone`).
- **`github.ts`** — All GitHub interaction via `gh` CLI (never HTTP API directly). Exponential-backoff retry on transient errors, rate-limit circuit breaker (60s cooldown), TTL cache with in-flight dedup.
- **`config.ts`** — Configuration priority: env vars > `~/.yeti/config.json` > defaults. Uses ESM `export let` for live reloads without restart. Exports `LABELS`, `INTERVALS`, `SCHEDULES`, `ALLOWED_REPOS`, `ENABLED_JOBS`, `JOB_AI`, etc. Per-job AI backend/model overrides via `jobAi` config map.
- **`db.ts`** — SQLite (`~/.yeti/yeti.db`) with tables: `tasks`, `job_runs`, `job_logs`. Log capture via `AsyncLocalStorage` run context.
- **`server.ts`** — HTTP dashboard with job status, work queue, log viewer, config editor. Token-based auth when `authToken` is set.
- **`error-reporter.ts`** — Deduplicating error reporter: logs + Discord + GitHub issues (`[yeti-error]`). 30-min cooldown per fingerprint. Filters `ShutdownError` and `RateLimitError`.
- **`discord.ts`** — Discord bot integration for notifications and job control commands. Uses discord.js. Supports GitHub commands: issue creation (`!yeti issue`), issue/PR analysis via Claude (`!yeti look`), and labeling issues as Refined (`!yeti assign`). Repos are short names scoped to the configured GitHub org.
- **`notify.ts`** — Notification dispatcher. Forwards messages to Discord.

### Jobs (`src/jobs/`)

Each job exports a `run()` function. Jobs discover work via comment analysis, reactions, labels, and PR state — not solely labels. Six labels exist: `Needs Refinement` (trigger for issue-refiner), `Needs Plan Review` (trigger for plan-reviewer), `Refined` (trigger for issue-worker), `Ready` (informational), `In Review` (informational), `Priority` (queue ordering). Processed items are tracked via thumbsup reactions on comments.

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
