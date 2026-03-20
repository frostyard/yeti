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

## Upgrading

### `enabledJobs` migration (required)

Starting from the release that introduces `enabledJobs`, you must explicitly list which jobs to run in `~/.yeti/config.json`. Without this field, **no jobs will start**.

**Before upgrading**, add `enabledJobs` to your config:

```json
{
  "enabledJobs": [
    "issue-worker",
    "issue-refiner",
    "ci-fixer",
    "review-addresser",
    "doc-maintainer",
    "auto-merger",
    "repo-standards",
    "improvement-identifier",
    "issue-auditor",
    "triage-yeti-errors"
  ]
}
```

The example above enables all jobs (matching previous default behavior). Remove any jobs you don't want to run.

**If you upgrade without updating config**, yeti will start but log a warning: *"No jobs enabled — yeti is running but idle."* You can then add `enabledJobs` to your config and yeti will pick it up via live reload — no restart needed.

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
| `enabledJobs` | — | `[]` (no jobs) | Which jobs to register with the scheduler (live-reloadable) |

### External tool authentication

These tools must be installed and authenticated on the host — they are **not** configured through `config.json` or environment variables:

| Tool | How to authenticate |
|---|---|
| `gh` CLI | `gh auth login` — must have access to all repos in `githubOwners` |
| `claude` CLI | Follow [Claude CLI setup](https://docs.anthropic.com/en/docs/claude-cli) |

## Jobs

Yeti runs 10 jobs on timers. Each job scans all repos under the configured `githubOwners`. Understanding what triggers each job is important — **most jobs do not require labels** and will discover work based on PR/issue state.

### Jobs that require labels

| Job | Trigger | What it does |
|-----|---------|--------------|
| **issue-worker** | `Refined` label on issue | Implements the issue in an isolated worktree, submits a PR |

### Jobs that act on existing Yeti work

These only fire when Yeti has already created branches or issues:

| Job | Trigger | What it does |
|-----|---------|--------------|
| **review-addresser** | `yeti/` branch PR with review comments | Addresses reviewer feedback on Yeti-created PRs |
| **triage-yeti-errors** | Issue with `[yeti-error]` in title | Investigates Yeti error issues |
| **repo-standards** | Periodic (daily) | Syncs label definitions — does not create PRs or issues |

### Jobs that act on ANY matching issue or PR

These scan all open issues/PRs and will do work without any Yeti-specific labels:

| Job | Trigger | What it does |
|-----|---------|--------------|
| **issue-refiner** | Any open issue without a plan comment | Generates an implementation plan comment |
| **ci-fixer** | Any PR with failing checks or merge conflicts | Attempts to fix CI failures and conflicts |
| **improvement-identifier** | Periodic scan of codebase | Creates PRs for code improvement opportunities |
| **issue-auditor** | All open issues | Audits and classifies issue state, applies labels |
| **doc-maintainer** | Code changes since last doc update | Updates documentation (only on already-cloned repos) |

### Auto-merge behaviour

The **auto-merger** job will merge PRs without human approval in these cases:

| PR type | Human review required? | Conditions for auto-merge |
|---------|----------------------|---------------------------|
| **Dependabot PRs** | No | All checks passing |
| **Doc PRs** (`yeti/docs-*`) | No | Only `.md` or `yeti/` files changed; checks pass or no checks configured |
| **Issue PRs** (`yeti/issue-*`) | **Yes** — requires LGTM | A valid LGTM comment must be posted after the latest commit |

All other PRs (non-Yeti, non-Dependabot) are ignored by auto-merger.

### Label workflow

Issues move through labels to track state:

```
(new issue)       →  (refiner runs)  →  Plan comment posted
Refined           →  (worker runs)   →  PR created  →  In Review
In Review + LGTM  →  (merger runs)   →  PR merged
```

The `Priority` label is used for queue ordering across all jobs but does not trigger any job on its own.

## Project structure

```
src/
├── main.ts              Entry point — sets up jobs and signal handlers
├── config.ts            Constants: owners, labels, intervals
├── scheduler.ts         Interval-based job runner (skip-if-busy)
├── github.ts            gh CLI wrapper
├── claude.ts            Claude CLI runner + git worktree helpers
├── log.ts               Timestamped logging
├── db.ts                SQLite for task tracking and job logs
├── server.ts            HTTP dashboard
├── error-reporter.ts    Deduplicating error reporter (Slack + GitHub issues)
├── discord.ts           Discord bot for notifications and commands
├── notify.ts            Fan-out notifications (Slack + Discord)
└── jobs/
    ├── issue-refiner.ts           Refines issues into implementation plans
    ├── issue-worker.ts            Implements issues as PRs
    ├── ci-fixer.ts                Fixes failing CI on PRs
    ├── auto-merger.ts             Auto-merges approved PRs
    ├── review-addresser.ts        Addresses PR review comments
    ├── improvement-identifier.ts  Identifies code improvements
    ├── issue-auditor.ts           Audits and classifies issues
    ├── doc-maintainer.ts          Keeps documentation up to date
    ├── repo-standards.ts          Syncs label definitions
    └── triage-yeti-errors.ts      Investigates yeti error issues
```

