# Configuration

Yeti's configuration lives in a single JSON file. Most settings can be changed at runtime without restarting the service, and the web dashboard provides a UI for editing them. This page covers the essentials to get Yeti working after a fresh install.

## Config file

```
~/.yeti/config.json
```

The install script creates this file with defaults. It is owned by your user and has `600` permissions (readable only by you, since it may contain tokens).

### Priority order

When the same setting is available in multiple places, the highest-priority source wins:

1. **Environment variables** (set in `~/.yeti/env` or the shell) --- highest priority
2. **Config file** (`~/.yeti/config.json`)
3. **Built-in defaults** --- lowest priority

## Essential settings

A fresh install will not process any work until you configure at least `enabledJobs`. Here are the fields to set first:

### `enabledJobs` --- Required

An array of job names to activate. **An empty array means nothing runs.** This is the most important setting to configure.

For a typical starting point, enable the core workflow jobs:

```json
"enabledJobs": [
  "issue-refiner",
  "issue-worker",
  "ci-fixer",
  "review-addresser",
  "auto-merger",
  "repo-standards"
]
```

All available jobs: `issue-refiner`, `issue-worker`, `ci-fixer`, `review-addresser`, `auto-merger`, `doc-maintainer`, `repo-standards`, `improvement-identifier`, `issue-auditor`, `triage-yeti-errors`, `plan-reviewer`, `mkdocs-update`.

### `githubOwners`

GitHub organizations or usernames whose repositories Yeti should scan. Defaults to `["frostyard"]`.

```json
"githubOwners": ["your-org", "your-username"]
```

### `allowedRepos`

An optional allow-list of specific repositories (by name, not full path) to process. When set, Yeti ignores all other repos under the configured owners. When `null` or omitted, all repos under the owners are eligible.

### `includeForks`

Whether to include forked repositories when scanning for work. Defaults to `false`. Set to `true` if you want Yeti to discover and process issues/PRs in forks.

```json
"includeForks": true
```

```json
"allowedRepos": ["frontend", "api", "docs"]
```

### `authToken`

A token to protect the web dashboard. When set, all dashboard requests require this token as a query parameter or via the login form. Leave empty to allow unauthenticated access (suitable for private networks).

```json
"authToken": "your-secret-token"
```

Alternatively (or additionally), you can enable GitHub OAuth sign-in --- see [GitHub App Setup](github-app.md#oauth-for-dashboard-optional).

### `discordBotToken` and `discordChannelId`

Optional. Enable the Discord bot for notifications and commands. Yeti will post job activity to the configured channel and respond to commands like `!yeti issue` and `!yeti look`.

```json
"discordBotToken": "your-bot-token",
"discordChannelId": "123456789012345678"
```

## Minimal config example

A lean configuration to get started. This watches one org, enables the core jobs, and protects the dashboard:

```json
{
  "githubOwners": ["your-org"],
  "enabledJobs": [
    "issue-refiner",
    "issue-worker",
    "ci-fixer",
    "review-addresser",
    "auto-merger",
    "repo-standards"
  ],
  "allowedRepos": ["your-first-repo"],
  "authToken": "pick-something-strong",
  "discordBotToken": "",
  "discordChannelId": ""
}
```

## Live reload

Most configuration changes take effect without restarting the service. When you edit `~/.yeti/config.json` (or save changes through the dashboard), Yeti picks up the new values on its next config reload cycle.

**Live-reloadable fields:**

- `enabledJobs`, `pausedJobs`
- `intervals` (all job polling intervals)
- `schedules` (daily job hours)
- `skippedItems`, `prioritizedItems`
- `allowedRepos`, `githubOwners`, `selfRepo`
- `authToken`
- `maxClaudeWorkers`, `claudeTimeoutMs`
- `maxCopilotWorkers`, `copilotTimeoutMs`
- `maxCodexWorkers`, `codexTimeoutMs`
- `jobAi`
- `includeForks`
- `reviewLoop`, `maxPlanRounds`
- `logLevel`
- `logRetentionDays`, `logRetentionPerJob`
- `queueScanIntervalMs`
- `discordAllowedUsers`

**Requires restart:**

- `port` --- the HTTP server binds once at startup
- `discordBotToken`, `discordChannelId` --- the Discord bot connects once at startup
- `githubAppId`, `githubAppInstallationId`, `githubAppPrivateKeyPath` --- see [GitHub App Setup](github-app.md)
- `githubAppClientId`, `githubAppClientSecret`, `externalUrl` --- see [GitHub App Setup --- OAuth](github-app.md#oauth-for-dashboard-optional)
- `webhookSecret` --- see [GitHub App Setup --- Webhooks](github-app.md#webhooks-optional)

## Next steps

With Yeti configured and running, it is time to walk through your first issue-to-PR cycle.

[Quickstart guide](quickstart.md){ .md-button .md-button--primary }

For the full reference of every config field, interval default, and environment variable, see the [Configuration Reference](../reference/configuration.md).
