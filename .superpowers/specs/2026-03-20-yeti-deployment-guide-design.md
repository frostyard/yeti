# Yeti Deployment Guide

**Date:** 2026-03-20
**Status:** Approved
**Approach:** CI/CD-first — push code, create first release via GitHub Actions, install on server via install.sh

## Overview

Step-by-step guide to deploy Yeti from a local codebase to a fresh Debian/Ubuntu Incus container with an empty private GitHub repo (`frostyard/yeti`). Uses GitHub-hosted Actions runners for CI/CD, the existing `install.sh` bootstrap, Discord for notifications/commands, and Tailscale Serve for secure dashboard access.

## Prerequisites

- Local machine with the Yeti codebase (this repo)
- Empty private GitHub repo at `frostyard/yeti`
- Provisioned Incus container (Debian) with: Node.js (will upgrade to 22), `gh` CLI, `claude` CLI, `git`, `curl`, `build-essential`, Tailscale (authenticated)
- Discord server where you can create a bot
- Tailscale network with the server already joined

## Phase 1: Push Code to GitHub

### 1.1 Fix CI/CD workflows for GitHub-hosted runners

Both `.github/workflows/ci.yml` and `.github/workflows/release.yml` currently use `runs-on: self-hosted`. Change both to `runs-on: ubuntu-latest`.

### 1.2 Initialize and push

```bash
# From the local repo root
git remote add origin git@github.com:frostyard/yeti.git
git push -u origin main
```

This first push to `main` triggers:
- **CI workflow**: build + test (validates the code compiles and tests pass)
- **Release workflow**: computes version tag `v2026-03-20.1`, builds tarball, creates GitHub release with `yeti.tar.gz`

### 1.3 Verify

- Check GitHub Actions tab — both workflows should complete green
- Check GitHub Releases — a release with `yeti.tar.gz` should exist

**Note:** Private repos get 2,000 free GitHub Actions minutes/month (Linux at 1x rate). The release workflow is lightweight.

## Phase 2: Upgrade Node.js on Server

The provisioning script installed Node.js 20, but Yeti requires 22.

SSH into the server as `yeti` and run:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs
node --version  # Should show v22.x
```

The provisioning script (`clincus.sh` line 92) should also be updated from `setup_20.x` to `setup_22.x` separately for future provisions.

## Phase 3: Authenticate CLIs

SSH into the server as `yeti`:

### 3.1 GitHub CLI

```bash
gh auth login
```

Interactive flow — authenticate with access to the `frostyard` org. Choose HTTPS or SSH as preferred. The `gh` CLI is used by both `install.sh` (to download releases) and Yeti at runtime (all GitHub API calls).

### 3.2 Claude CLI

```bash
claude
```

Interactive login flow. The Claude CLI is invoked by Yeti to process issues, PRs, and other automation tasks in isolated worktrees.

## Phase 4: Install Yeti

### 4.1 Run install.sh

```bash
gh api repos/frostyard/yeti/contents/deploy/install.sh --jq .content | base64 -d | bash
```

This:
- Creates `/opt/yeti` owned by the `yeti` user
- Downloads the latest release tarball
- Extracts `dist/`, `deploy/`, `node_modules/` to `/opt/yeti`
- Installs systemd units (`yeti.service`, `yeti-updater.service`, `yeti-updater.timer`)
- Creates skeleton `~/.yeti/config.json` and `~/.yeti/env`
- Enables and starts the `yeti` service and auto-updater timer

### 4.2 Create Discord bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications), create a new Application
2. Navigate to the **Bot** section, create a bot
3. Enable **Message Content Intent** under Privileged Gateway Intents
4. Copy the **bot token**
5. Navigate to **OAuth2 → URL Generator**, select scopes: `bot`, permissions: `Send Messages`, `Read Message History`
6. Use the generated URL to invite the bot to your Discord server
7. Create a private `#yeti` channel and add the bot to it
8. Enable Developer Mode in Discord settings (User Settings → Advanced → Developer Mode)
9. Right-click the `#yeti` channel → **Copy Channel ID**
10. Right-click your Discord user → **Copy User ID** (for the allowlist)

### 4.3 Edit configuration

Edit `~/.yeti/config.json`:

```json
{
  "githubOwners": ["frostyard"],
  "selfRepo": "frostyard/yeti",
  "discordBotToken": "<bot token from step 4>",
  "discordChannelId": "<channel ID from step 9>",
  "discordAllowedUsers": ["<your user ID from step 10>"],
  "authToken": "<generate a strong random string>",
  "slackWebhook": "",
  "slackBotToken": "",
  "slackIdeasChannel": ""
}
```

Only the fields you want to change need to be present — the skeleton config has sensible defaults for everything else (intervals, schedules, worker count, etc.).

### 4.4 Restart Yeti

Discord bot token and channel ID are immutable config — they require a restart to take effect:

```bash
sudo systemctl restart yeti
```

## Phase 5: Tailscale Serve

Expose the dashboard securely over Tailscale:

```bash
sudo tailscale set --hostname=yeti
sudo tailscale serve --bg https / http://localhost:9384
```

The dashboard is now accessible at `https://yeti.<tailnet>.ts.net` from any device on your Tailscale network. TLS is handled automatically by Tailscale.

Security is two layers:
- **Network level**: Tailscale ACLs control who can reach the machine
- **Application level**: `authToken` in config requires login to access the dashboard

## Phase 6: Verify

### 6.1 Health check

```bash
curl http://localhost:9384/health
# Expected: {"status":"ok","version":"v2026-03-20.1"}
```

### 6.2 Systemd services

```bash
sudo systemctl status yeti              # Active and running
sudo systemctl status yeti-updater.timer # Active, next trigger scheduled
```

### 6.3 Logs

```bash
journalctl -u yeti -n 50
```

Expect to see: DB initialized, orphan recovery, jobs registered, scheduler started, HTTP server listening on 9384, Discord connected.

### 6.4 Dashboard

Open `https://yeti.<tailnet>.ts.net` in a browser. Log in with your auth token. Verify:
- All jobs listed with their states
- Queue page loads
- Logs page loads
- Config page shows your settings (tokens masked)

### 6.5 Discord

Send `!yeti status` in your `#yeti` channel. The bot should reply with job states, uptime, and queue size.

### 6.6 Auto-updater

The auto-updater checks for new releases every 60 seconds. Verify the timer is active:

```bash
sudo systemctl status yeti-updater.timer
```

Future pushes to `main` will automatically create releases, and the updater will download and deploy them with health-check rollback.

## Ongoing Operations

- **View logs**: `journalctl -u yeti -f` or the dashboard logs page
- **Manual job trigger**: `!yeti trigger <job-name>` in Discord, or POST `/trigger/<job>` on dashboard
- **Pause/resume jobs**: `!yeti pause <job>` / `!yeti resume <job>`, or via dashboard
- **Config changes**: Edit `~/.yeti/config.json` (live-reloaded for most settings) or use the dashboard config page. Restart required for `discordBotToken`, `discordChannelId`, `port`.
- **Deploy new code**: Push to `main` — release workflow builds tarball, auto-updater picks it up within 60s, health-checks, auto-rolls back on failure
- **Rollback**: Automatic on health check failure. Manual: `sudo systemctl stop yeti`, restore `dist.prev`, `sudo systemctl start yeti`

## Scope Boundaries

**In scope:**
- Pushing codebase to GitHub
- Fixing CI/CD for GitHub-hosted runners
- Node.js 22 upgrade on server
- CLI authentication (gh, claude)
- install.sh bootstrap
- Discord bot creation and configuration
- Tailscale Serve for dashboard
- Verification checklist

**Out of scope:**
- Slack setup (being removed)
- WhatsApp setup
- Provisioning script fix (Node 22) — done separately
- Custom job intervals/schedules tuning
- Tailscale ACL configuration
- DNS/custom domain setup
