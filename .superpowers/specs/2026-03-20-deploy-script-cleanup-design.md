# Deploy Script Cleanup Design

**Date:** 2026-03-20
**Status:** Approved

## Summary

Update `deploy/install.sh` and `deploy/deploy.sh` to remove deprecated kwyjibo configuration and align bootstrap templates with the current `ConfigFile` interface in `src/config.ts`. Add CLAUDE.md guidance to keep deploy scripts in sync with future config changes.

## Scope

| File | Action |
|------|--------|
| `deploy/install.sh` | Replace bootstrap config.json and env templates |
| `deploy/deploy.sh` | Remove Slack notification code |
| `CLAUDE.md` | Add deployment scripts awareness note |
| `deploy/uninstall.sh` | No changes |
| `deploy/yeti.service` | No changes |
| `deploy/yeti-updater.*` | No changes |

## Changes

### 1. `install.sh` — Bootstrap config.json template

Replace the current template (which contains deprecated `kwyjiboBaseUrl` and `kwyjiboApiKey`) with a comprehensive template covering all `ConfigFile` fields:

```json
{
  "githubOwners": ["frostyard"],
  "selfRepo": "frostyard/yeti",
  "port": 9384,
  "slackWebhook": "",
  "slackBotToken": "",
  "slackIdeasChannel": "",
  "discordBotToken": "",
  "discordChannelId": "",
  "discordAllowedUsers": [],
  "whatsappEnabled": false,
  "whatsappAllowedNumbers": [],
  "openaiApiKey": "",
  "authToken": "",
  "maxClaudeWorkers": 2,
  "claudeTimeoutMs": 1200000,
  "intervals": {
    "issueWorkerMs": 300000,
    "issueRefinerMs": 300000,
    "ciFixerMs": 600000,
    "reviewAddresserMs": 300000,
    "autoMergerMs": 600000,
    "triageYetiErrorsMs": 600000
  },
  "schedules": {
    "docMaintainerHour": 1,
    "repoStandardsHour": 2,
    "improvementIdentifierHour": 3,
    "issueAuditorHour": 5
  },
  "logRetentionDays": 14,
  "logRetentionPerJob": 20,
  "pausedJobs": [],
  "skippedItems": [],
  "prioritizedItems": []
}
```

Defaults match those in `src/config.ts`. `githubOwners` reduced from duplicate `["frostyard", "frostyard"]` to `["frostyard"]`. (The duplicate also exists in `config.ts` line 100 — fix it there too as a drive-by.)

Also update the log message on line 55 from "edit it to set your Slack webhook URL" to "edit it to configure your instance" since the template now covers many more fields.

### 2. `install.sh` — Bootstrap env file template

Replace the current template (which contains deprecated `KWYJIBO_*` vars) with secrets-only env vars:

```bash
# Environment variables loaded by the yeti systemd unit.
# Uncomment and set values as needed. These override config.json.

# Slack
# YETI_SLACK_WEBHOOK=https://hooks.slack.com/services/T.../B.../xxx
# YETI_SLACK_BOT_TOKEN=xoxb-...

# Discord
# YETI_DISCORD_BOT_TOKEN=

# OpenAI (used for WhatsApp voice transcription)
# OPENAI_API_KEY=

# Dashboard auth
# YETI_AUTH_TOKEN=
```

Non-secret configuration belongs in `config.json`, not the env file.

### 3. `deploy.sh` — Remove Slack notifications

Remove all notification-related code:
- `CONFIG_SLACK_WEBHOOK` / `SLACK_WEBHOOK` variable reading (lines 28-29)
- Warning about missing webhook (line 35)
- `slack()` function definition (lines 36-43)
- All `slack "..."` calls in rollback and success paths (lines 154, 160, 167, 182)

This removes the `jq` dependency from deploy.sh. (`curl` remains — used by the health check.) The app itself handles notifications via `notify.ts` (Slack + Discord fan-out) when it starts up after a deploy.

Everything else in deploy.sh remains: version checking, download, backup, stop/start, health check, rollback logic.

### 4. `CLAUDE.md` — Deploy script awareness

Add a section after the existing "Deployment" section:

```markdown
## Deployment Scripts

After any change to `src/config.ts` (new config fields, removed fields, env var changes), update the bootstrap templates in `deploy/install.sh` to match. Also review `deploy/deploy.sh` if the deployment lifecycle changes.
```

## Non-goals

- No changes to the auto-updater timer interval or systemd units
- No build-time template generation (config changes infrequently)
- No merging of install/deploy/uninstall into a single script
- No adding Discord notifications to deploy.sh (app handles this)
