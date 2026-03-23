# Jobs Overview

Yeti's work is organized into jobs -- each one a focused unit of automation that runs on a timer or a daily schedule. Like a well-organized patrol through frozen terrain, every job has a clear route and knows exactly what to look for.

---

## Interval Jobs

These jobs poll on a timer, checking for new work each cycle.

| Job | Default Interval | AI | Description |
|-----|:----------------:|:---:|-------------|
| [issue-refiner](issue-refiner.md) | 5 min | Yes | Generate and refine implementation plans for issues |
| [plan-reviewer](plan-reviewer.md) | 10 min | Yes | Adversarial review of implementation plans |
| [issue-worker](issue-worker.md) | 5 min | Yes | Implement approved issues as pull requests |
| [ci-fixer](ci-fixer.md) | 10 min | Yes | Fix failing CI checks and merge conflicts |
| [auto-merger](auto-merger.md) | 10 min | No | Auto-merge qualifying pull requests |
| [review-addresser](review-addresser.md) | 5 min | Yes | Address PR review comments |
| [triage-yeti-errors](triage-yeti-errors.md) | 10 min | Yes | Investigate Yeti's own error reports |

## Scheduled Jobs

These jobs run once daily at a configured hour (local timezone). They also run on startup if their scheduled time has passed since the last run.

| Job | Default Hour | AI | Description |
|-----|:-----------:|:---:|-------------|
| [doc-maintainer](doc-maintainer.md) | 1 AM | Yes | Update repository documentation |
| [repo-standards](repo-standards.md) | 2 AM | No | Sync labels to all repositories |
| [improvement-identifier](improvement-identifier.md) | 3 AM | Yes | Find codebase improvements and implement them as PRs |
| [mkdocs-update](mkdocs-update.md) | 4 AM | Yes | Update MkDocs documentation sites |
| [issue-auditor](issue-auditor.md) | 5 AM | No | Audit and fix issue label state |

---

## Enabling Jobs

**All jobs must be listed in the `enabledJobs` config array to run.** An empty array means nothing runs -- Yeti sits idle, waiting.

```json
{
  "enabledJobs": [
    "issue-refiner",
    "issue-worker",
    "ci-fixer"
  ]
}
```

### Recommended Starter Set

If you are setting up Yeti for the first time, start with the core trio:

- **`issue-refiner`** -- Plans issues
- **`issue-worker`** -- Implements plans as PRs
- **`ci-fixer`** -- Fixes CI failures on Yeti PRs

Add more jobs as you grow comfortable with the workflow:

- **`auto-merger`** -- Hands-free merging of approved PRs
- **`repo-standards`** -- Keeps labels in sync
- **`review-addresser`** -- Handles PR review comments

The full set including nightly jobs (`doc-maintainer`, `improvement-identifier`, `issue-auditor`, `mkdocs-update`) rounds out a fully autonomous setup.

---

## Job Behavior

### Skip-if-Busy

Jobs use skip-if-busy scheduling: if a job's previous run is still active when the next interval fires, the new run is silently skipped. This prevents queue pile-up during long-running tasks.

### Pause and Resume

Jobs can be paused via the dashboard or API (`POST /pause/:job`). Paused jobs remain registered but do not execute. The pause state is persisted to `config.json`.

### Manual Trigger

Any job can be manually triggered via the dashboard or API (`POST /trigger/:job`), regardless of its normal schedule. Manual triggers respect skip-if-busy -- if the job is already running, the trigger returns `409`.

### AI Backend

Jobs marked "AI: Yes" use Claude CLI by default. Individual jobs can be routed to a different backend (e.g., Copilot or Codex) or model via the [`jobAi` config](../configuration.md#example-per-job-ai-overrides).

### Rate Limiting

All jobs respect the GitHub API rate limit circuit breaker. When rate limiting is detected, jobs stop processing new items and wait for the 60-second cooldown to expire.
