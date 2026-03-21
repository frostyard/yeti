# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Agent Planning

**superpowers planning docs** Save plans to .superpowers/plans instead of yeti/plans/
**superpowers spec docs** Save specs to .superpowers/specs/ instead of yeti/specs/

## Documentation

**update documentation** After any change to source code, update relevant documentation in CLAUDE.md, README.md and the yeti/ folder. A task is not complete without reviewing and updating relevant documentation.

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

## Architecture

Yeti is a self-hosted GitHub automation daemon that polls repositories on timers and delegates work to the `claude` CLI in isolated git worktrees. It runs as a systemd service on Linux (Node.js 22, ESM, strict TypeScript).

### Core modules

- **`main.ts`** — Entry point. Initializes SQLite DB, recovers orphaned tasks from prior crashes, registers ~10 jobs with the scheduler, starts the HTTP server, sets up live config reload and graceful shutdown (SIGINT/SIGTERM).
- **`scheduler.ts`** — Interval/daily-hour job runner with skip-if-busy semantics (no queue pile-up). Supports pause/resume, manual trigger, live interval updates.
- **`claude.ts`** — Bounded concurrent queue (default 2 workers) for `claude` CLI processes. Also manages git worktree lifecycle (`createWorktree`/`removeWorktree`/`ensureClone`). Each process has a configurable timeout (default 20min) with SIGTERM→SIGKILL escalation.
- **`github.ts`** — All GitHub interaction via `gh` CLI (never HTTP API directly). Exponential-backoff retry on transient errors, rate-limit circuit breaker (60s cooldown), TTL cache with in-flight dedup.
- **`config.ts`** — Configuration priority: env vars > `~/.yeti/config.json` > defaults. Uses ESM `export let` for live reloads without restart. Exports `LABELS`, `INTERVALS`, `SCHEDULES`, `ALLOWED_REPOS`, `ENABLED_JOBS`, etc.
- **`db.ts`** — SQLite (`~/.yeti/yeti.db`) with tables: `tasks`, `job_runs`, `job_logs`. Log capture via `AsyncLocalStorage` run context.
- **`server.ts`** — HTTP dashboard with job status, work queue, log viewer, config editor. Token-based auth when `authToken` is set.
- **`error-reporter.ts`** — Deduplicating error reporter: logs + Slack + GitHub issues (`[yeti-error]`). 30-min cooldown per fingerprint. Filters `ShutdownError` and `RateLimitError`.
- **`discord.ts`** — Discord bot integration for notifications and job control commands. Uses discord.js. Supports GitHub commands: issue creation (`!yeti issue`), issue/PR analysis via Claude (`!yeti look`), and labeling issues as Refined (`!yeti assign`). Repos are short names scoped to the configured GitHub org.
- **`notify.ts`** — Fan-out notification module. Forwards messages to both Slack and Discord.

### Jobs (`src/jobs/`)

Each job exports a `run()` function. Jobs discover work via comment analysis, reactions, labels, and PR state — not solely labels. Four labels exist: `Refined` (trigger), `Ready` (informational), `In Review` (informational), `Priority` (queue ordering). Processed items are tracked via thumbsup reactions on comments.

Jobs must be listed in the `enabledJobs` config array to run. An empty or missing `enabledJobs` means no jobs start.

### Key patterns

- **Worktree isolation**: Each task gets `~/.yeti/worktrees/<owner>/<repo>/<job>/<branch>`, cleaned up in `finally` blocks.
- **Content-based state machine**: Issue/PR state is inferred from comments and reactions, not label-driven workflows.
- **Two-phase identify/process**: Used by ci-fixer, improvement-identifier, issue-refiner — scan all items first, then process (prevents race conditions with concurrent GitHub API calls).
- **Crash recovery**: On startup, tasks still marked `running` in DB get their worktrees cleaned and are marked `failed`.

## Testing

Tests are co-located (`*.test.ts` next to source). Heavy mocking of external boundaries (`gh` CLI, `claude` CLI, filesystem). Use `vi.mock()` at module level. Test helpers in `src/test-helpers.ts` provide `mockRepo()`, `mockIssue()`, `mockPR()` factories.

## Deployment

- Deployed to `/opt/yeti` via systemd (`deploy/yeti.service`)
- Auto-updates via `yeti-updater.timer` checking GitHub releases every 60s
- Version tags: `v<YYYY-MM-DD>.<N>` — release workflow on push to `main`
- Release tarball: `dist/` + `deploy/` + `node_modules/`
- Health check: `GET /health` on port 9384

## Deployment Scripts

After any change to `src/config.ts` (new config fields, removed fields, env var changes), update the bootstrap templates in `deploy/install.sh` to match. Also review `deploy/deploy.sh` if the deployment lifecycle changes.
