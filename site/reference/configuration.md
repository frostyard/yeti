# Configuration Reference

Every setting that shapes how Yeti operates, from the org it watches to the intervals between each patrol of your repositories.

**Config file:** `~/.yeti/config.json`

**Priority:** Environment variables > config file > defaults

Changes to live-reloadable fields take effect without restarting the service. Other fields require a restart.

---

## General Settings

| Field | Type | Default | Env Var | Live Reload | Description |
|-------|------|---------|---------|:-----------:|-------------|
| `githubOwners` | `string[]` | `["frostyard"]` | `YETI_GITHUB_OWNERS` (comma-sep) | Yes | GitHub orgs/users to scan for repositories |
| `selfRepo` | `string` | `frostyard/yeti` | `YETI_SELF_REPO` | Yes | Repository where Yeti files error issues about itself |
| `port` | `number` | `9384` | `PORT` | No | HTTP dashboard port |
| `authToken` | `string` | `""` | `YETI_AUTH_TOKEN` | Yes | Dashboard auth token (empty = no auth) |
| `allowedRepos` | `string[] \| null` | `null` | `YETI_ALLOWED_REPOS` (comma-sep) | Yes | Repo allow-list. `null` means all repos under `githubOwners` are scanned |
| `logLevel` | `"debug" \| "info" \| "warn" \| "error"` | `"debug"` | `YETI_LOG_LEVEL` | Yes | Minimum log level for console and stored logs |
| `logRetentionDays` | `number` | `14` | -- | Yes | Delete logs older than N days |
| `logRetentionPerJob` | `number` | `20` | -- | Yes | Max log runs to keep per job |
| `includeForks` | `boolean` | `false` | `YETI_INCLUDE_FORKS` | Yes | Include forked repositories when scanning for work |
| `queueScanIntervalMs` | `number` | `300000` (5 min) | -- | Yes | How often the lightweight queue label scanner runs |

## AI Backend Settings

| Field | Type | Default | Env Var | Live Reload | Description |
|-------|------|---------|---------|:-----------:|-------------|
| `maxClaudeWorkers` | `number` | `2` | `YETI_MAX_CLAUDE_WORKERS` | Yes | Max concurrent Claude CLI processes |
| `claudeTimeoutMs` | `number` | `1200000` (20 min) | `YETI_CLAUDE_TIMEOUT_MS` | Yes | Timeout per Claude call (minimum 60s) |
| `maxCopilotWorkers` | `number` | `1` | `YETI_MAX_COPILOT_WORKERS` | Yes | Max concurrent Copilot CLI processes |
| `copilotTimeoutMs` | `number` | `1200000` (20 min) | `YETI_COPILOT_TIMEOUT_MS` | Yes | Timeout per Copilot call (minimum 60s) |
| `maxCodexWorkers` | `number` | `1` | `YETI_MAX_CODEX_WORKERS` | Yes | Max concurrent Codex CLI processes (0 to disable) |
| `codexTimeoutMs` | `number` | `1200000` (20 min) | `YETI_CODEX_TIMEOUT_MS` | Yes | Timeout per Codex call (minimum 60s) |
| `jobAi` | `Record<string, {backend?, model?}>` | `{}` | -- | Yes | Per-job AI backend and model overrides |

## Discord Integration

| Field | Type | Default | Env Var | Live Reload | Description |
|-------|------|---------|---------|:-----------:|-------------|
| `discordBotToken` | `string` | `""` | `YETI_DISCORD_BOT_TOKEN` | No | Discord bot token (requires restart to connect) |
| `discordChannelId` | `string` | `""` | `YETI_DISCORD_CHANNEL_ID` | No | Discord channel for notifications |
| `discordAllowedUsers` | `string[]` | `[]` | `YETI_DISCORD_ALLOWED_USERS` (comma-sep) | Yes | Discord user IDs allowed to run commands |

## GitHub App Authentication

All three fields must be set to enable GitHub App auth. These fields require a restart --- they are read once at startup. See [GitHub App Setup](../getting-started/github-app.md) for a step-by-step guide.

| Field | Type | Default | Env Var | Live Reload | Description |
|-------|------|---------|---------|:-----------:|-------------|
| `githubAppId` | `string` | `""` | `YETI_GITHUB_APP_ID` | No | GitHub App ID (numeric string) |
| `githubAppInstallationId` | `string` | `""` | `YETI_GITHUB_APP_INSTALLATION_ID` | No | Installation ID for the App on your org |
| `githubAppPrivateKeyPath` | `string` | `""` | `YETI_GITHUB_APP_PRIVATE_KEY_PATH` | No | Absolute path to the App's `.pem` private key file |

## GitHub OAuth (Dashboard Sign-In)

Optional. Enables "Sign in with GitHub" on the dashboard login page. All three fields must be set to activate OAuth. These fields require a restart. See [GitHub App Setup — OAuth](../getting-started/github-app.md#oauth-for-dashboard-optional) for setup steps.

| Field | Type | Default | Env Var | Live Reload | Description |
|-------|------|---------|---------|:-----------:|-------------|
| `githubAppClientId` | `string` | `""` | `YETI_GITHUB_APP_CLIENT_ID` | No | OAuth client ID from the GitHub App |
| `githubAppClientSecret` | `string` | `""` | `YETI_GITHUB_APP_CLIENT_SECRET` | No | OAuth client secret (sensitive — masked in API/dashboard) |
| `externalUrl` | `string` | `""` | `YETI_EXTERNAL_URL` | No | Public URL for OAuth callback, e.g., `https://yeti.example.com` |

## Webhooks

Optional. Enables GitHub webhook support for near-real-time job triggers. See [GitHub App Setup — Webhooks](../getting-started/github-app.md#webhooks-optional) for setup steps.

| Field | Type | Default | Env Var | Live Reload | Description |
|-------|------|---------|---------|:-----------:|-------------|
| `webhookSecret` | `string` | `""` | `YETI_WEBHOOK_SECRET` | No | HMAC-SHA256 secret for verifying GitHub webhook payloads (sensitive — masked in API/dashboard) |

## Job Control

| Field | Type | Default | Env Var | Live Reload | Description |
|-------|------|---------|---------|:-----------:|-------------|
| `enabledJobs` | `string[]` | `[]` | -- | Yes | Jobs to register. **Empty = nothing runs.** |
| `pausedJobs` | `string[]` | `[]` | -- | Yes | Paused job names (registered but not executing) |
| `skippedItems` | `{repo, number}[]` | `[]` | -- | Yes | Issues/PRs to skip during processing |
| `prioritizedItems` | `{repo, number}[]` | `[]` | -- | Yes | High-priority items processed first |

## Plan Review Loop

| Field | Type | Default | Env Var | Live Reload | Description |
|-------|------|---------|---------|:-----------:|-------------|
| `reviewLoop` | `boolean` | `false` | -- | Yes | Enable iterative plan refinement. When true, plan-reviewer can send plans back to issue-refiner instead of always marking Ready. |
| `maxPlanRounds` | `number` | `3` | -- | Yes | Maximum plan→review cycles before falling through to human review. Minimum 1. |

## Intervals

All interval fields live inside the `intervals` object, are specified in milliseconds, and are live-reloadable.

| Field | Default | Description |
|-------|---------|-------------|
| `issueWorkerMs` | `300000` (5 min) | issue-worker poll interval |
| `issueRefinerMs` | `300000` (5 min) | issue-refiner poll interval |
| `ciFixerMs` | `600000` (10 min) | ci-fixer poll interval |
| `reviewAddresserMs` | `300000` (5 min) | review-addresser poll interval |
| `autoMergerMs` | `600000` (10 min) | auto-merger poll interval |
| `triageYetiErrorsMs` | `600000` (10 min) | triage-yeti-errors poll interval |
| `planReviewerMs` | `600000` (10 min) | plan-reviewer poll interval |

## Schedules

All schedule fields live inside the `schedules` object, are specified as hour of day in local timezone (0-23), and are live-reloadable.

| Field | Default | Description |
|-------|---------|-------------|
| `docMaintainerHour` | `1` (1 AM) | doc-maintainer run hour |
| `repoStandardsHour` | `2` (2 AM) | repo-standards run hour |
| `improvementIdentifierHour` | `3` (3 AM) | improvement-identifier run hour |
| `mkdocsUpdateHour` | `4` (4 AM) | mkdocs-update run hour |
| `issueAuditorHour` | `5` (5 AM) | issue-auditor run hour |
| `promptEvaluatorHour` | `0` (Midnight) | prompt-evaluator run hour |

---

## Example: Per-Job AI Overrides

The `jobAi` field lets you route specific jobs to different AI backends or models. This is useful when you want a second perspective -- for instance, running plan reviews through a different provider than the one that wrote the plan.

```json
{
  "jobAi": {
    "plan-reviewer": { "backend": "copilot" },
    "doc-maintainer": { "backend": "codex" },
    "issue-refiner": { "model": "opus" }
  }
}
```

Supported backends: `claude` (default), `copilot`, and `codex`. When a `backend` is specified, the job's work is queued through that backend's worker pool (respecting its own concurrency limits and timeouts). When only a `model` is specified, the job still uses the default Claude backend but passes the model name through.

---

## Example: Minimal Config

A cold-start configuration to get Yeti running on a single org with the essential jobs:

```json
{
  "githubOwners": ["my-org"],
  "selfRepo": "my-org/yeti",
  "authToken": "a-secret-token",
  "enabledJobs": [
    "issue-refiner",
    "issue-worker",
    "ci-fixer",
    "auto-merger",
    "repo-standards"
  ]
}
```

## Example: Full Config

A more complete configuration with intervals, schedules, and integrations:

```json
{
  "githubOwners": ["my-org"],
  "selfRepo": "my-org/yeti",
  "authToken": "a-secret-token",
  "discordBotToken": "discord-bot-token",
  "discordChannelId": "1234567890",
  "discordAllowedUsers": ["user-id-1", "user-id-2"],
  "githubAppId": "123456",
  "githubAppInstallationId": "78901234",
  "githubAppPrivateKeyPath": "/home/yeti/.yeti/github-app.pem",
  "githubAppClientId": "Iv1.abc123...",
  "githubAppClientSecret": "your-client-secret",
  "externalUrl": "https://yeti.example.com",
  "webhookSecret": "your-webhook-secret",
  "maxClaudeWorkers": 2,
  "claudeTimeoutMs": 1200000,
  "maxCopilotWorkers": 1,
  "maxCodexWorkers": 1,
  "includeForks": false,
  "enabledJobs": [
    "issue-refiner",
    "plan-reviewer",
    "issue-worker",
    "ci-fixer",
    "auto-merger",
    "review-addresser",
    "triage-yeti-errors",
    "doc-maintainer",
    "repo-standards",
    "improvement-identifier",
    "issue-auditor",
    "mkdocs-update",
    "prompt-evaluator"
  ],
  "intervals": {
    "issueWorkerMs": 300000,
    "issueRefinerMs": 300000,
    "ciFixerMs": 600000
  },
  "schedules": {
    "docMaintainerHour": 1,
    "repoStandardsHour": 2,
    "improvementIdentifierHour": 3,
    "mkdocsUpdateHour": 4,
    "issueAuditorHour": 5,
    "promptEvaluatorHour": 0
  },
  "jobAi": {
    "plan-reviewer": { "backend": "copilot" }
  },
  "reviewLoop": false,
  "maxPlanRounds": 3,
  "logLevel": "debug",
  "logRetentionDays": 14,
  "logRetentionPerJob": 20
}
```
