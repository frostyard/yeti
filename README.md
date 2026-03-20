# yeti

Scheduled GitHub automation powered by the Claude CLI.

Yeti periodically scans GitHub repositories and uses Claude to:

- **Plan issues** — issues labelled `Needs Refinement` get an AI-generated implementation plan posted as a comment
- **Work issues** — issues labelled `Refined` are picked up, implemented in an isolated worktree, and submitted as a PR
- **Fix CI** — open PRs with failing checks are analysed and patched automatically

## How it works

Three jobs run on simple timers (5 min for issues, 10 min for CI). Each job:

1. Queries GitHub via the `gh` CLI for matching issues/PRs
2. Creates a git worktree for isolation
3. Runs the `claude` CLI with a task-specific prompt
4. Pushes results (PR, comment, or commits) back to GitHub
5. Cleans up the worktree

A serial queue ensures only one Claude process runs at a time. Labels (`yeti-working`, etc.) coordinate state and prevent duplicate work.

## Deployment

Yeti runs as a systemd service on a Linux server. An accompanying timer-based updater automatically pulls new GitHub releases, swaps the build artefacts, and restarts the service (with automatic rollback on health-check failure).

### Prerequisites

| Tool | Purpose |
|------|---------|
| Node.js 22 | Runtime |
| `gh` CLI | GitHub API access (must be authenticated) |
| `claude` CLI | AI execution |
| `git` | Worktree management |

### Building

```sh
npm ci
npm run build
```

### Installing

```sh
gh api repos/frostyard/yeti/contents/deploy/install.sh --jq .content | base64 -d | bash
```

This downloads the latest release to `/opt/yeti`, installs the systemd units (templated to the current user), and starts the service. Requires `gh` CLI to be installed and authenticated.

### Running

The service is managed by systemd:

```sh
sudo systemctl start yeti      # start
sudo systemctl stop yeti       # stop (sends SIGTERM, waits for in-flight jobs)
sudo systemctl status yeti     # check status
journalctl -u yeti -f          # tail logs
```

The process handles `SIGTERM` gracefully, so systemd can stop it cleanly.

### Auto-updates

The `yeti-updater.timer` checks for new GitHub releases every 60 seconds. When a new release is found, `deploy/deploy.sh` downloads the tarball, swaps the `dist/` directory, restarts the service, and verifies health via `http://localhost:9384/health`. If the health check fails, it automatically rolls back to the previous version.

## Configuration

Configuration is resolved per-field in this priority order:

1. **Environment variables** (highest priority)
2. **Config file** at `~/.yeti/config.json`
3. **Hardcoded defaults** (where a sensible default exists)

### Required setup before first run

The `install.sh` script creates a skeleton `~/.yeti/config.json`. Before starting the service you **must** populate the following value — it has no usable default:

| Config key | Env variable | Description |
|---|---|---|
| `slackWebhook` | `YETI_SLACK_WEBHOOK` | Slack incoming-webhook URL for deploy/error notifications |

Set it in **either** `~/.yeti/config.json`:

```json
{
  "slackWebhook": "https://hooks.slack.com/services/T.../B.../xxx"
}
```

**or** in `~/.yeti/env` (loaded by the systemd unit):

```sh
YETI_SLACK_WEBHOOK=https://hooks.slack.com/services/T.../B.../xxx
```

The service will start without it, but all Slack notifications will be silently skipped.

### All configuration options

| Config key | Env variable | Default | Description |
|---|---|---|---|
| `slackWebhook` | `YETI_SLACK_WEBHOOK` | *(empty — must be set)* | Slack incoming-webhook URL |
| `githubOwners` | `YETI_GITHUB_OWNERS` | `["frostyard","frostyard"]` | GitHub accounts to scan (env var is comma-separated) |
| `selfRepo` | `YETI_SELF_REPO` | `frostyard/yeti` | Repo used for self-referencing error issues |
| `port` | `PORT` | `9384` | HTTP server port |
| `intervals.issueWorkerMs` | — | `300000` (5 min) | Issue worker poll interval |
| `intervals.issueRefinerMs` | — | `300000` (5 min) | Issue refiner poll interval |
| `intervals.ciFixerMs` | — | `600000` (10 min) | CI fixer poll interval |
| `intervals.reviewAddresserMs` | — | `300000` (5 min) | Review addresser poll interval |

### External tool authentication

These tools must be installed and authenticated on the host — they are **not** configured through `config.json` or environment variables:

| Tool | How to authenticate |
|---|---|
| `gh` CLI | `gh auth login` — must have access to all repos in `githubOwners` |
| `claude` CLI | Follow [Claude CLI setup](https://docs.anthropic.com/en/docs/claude-cli) |

### Label workflow

Issues move through labels to track state:

```
Needs Refinement  →  (refiner runs)  →  Plan Produced
Refined           →  (worker runs)   →  PR created
```

PRs with failing CI are automatically patched. If the fix doesn't resolve the failure, the ci-fixer will retry on the next cycle.

## Project structure

```
src/
├── main.ts              Entry point — sets up jobs and signal handlers
├── config.ts            Constants: owners, labels, intervals
├── scheduler.ts         Interval-based job runner (skip-if-busy)
├── github.ts            gh CLI wrapper
├── claude.ts            Claude CLI runner + git worktree helpers
├── log.ts               Timestamped logging
└── jobs/
    ├── issue-refiner.ts   Refines issues into implementation plans
    ├── issue-worker.ts    Implements issues as PRs
    └── ci-fixer.ts        Fixes failing CI on PRs
```

