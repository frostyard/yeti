#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="/opt/yeti"
# Resolve repo: .repo file (from extracted tarball) → argument → default
if [[ -f "$INSTALL_DIR/.repo" ]]; then
  REPO=$(cat "$INSTALL_DIR/.repo")
else
  REPO="${1:-frostyard/yeti}"
fi
USER_NAME="$(whoami)"

log() { echo "==> $*"; }

# Must have gh CLI available
if ! command -v gh &>/dev/null; then
  echo "Error: gh CLI is required. Install it from https://cli.github.com" >&2
  exit 1
fi

# Create install directory
log "Creating $INSTALL_DIR (owned by $USER_NAME)"
sudo mkdir -p "$INSTALL_DIR"
sudo chown "$USER_NAME":"$USER_NAME" "$INSTALL_DIR"

# Download and extract latest release
log "Downloading latest release..."
LATEST_TAG=$(gh release list -R "$REPO" --limit 1 --json tagName --jq '.[0].tagName')
TMPFILE=$(mktemp /tmp/yeti-XXXXXX.tar.gz)
gh release download -R "$REPO" --pattern 'yeti.tar.gz' -O "$TMPFILE" --clobber
tar -xzf "$TMPFILE" -C "$INSTALL_DIR"
rm -f "$TMPFILE"
echo "$LATEST_TAG" > "$INSTALL_DIR/.current-version"

# Patch the service unit with the current user and PATH
log "Installing systemd units for user $USER_NAME..."
sed "s/User=yeti/User=$USER_NAME/;s/Group=yeti/Group=$USER_NAME/;s|/home/yeti/|/home/$USER_NAME/|" \
  "$INSTALL_DIR/deploy/yeti.service" | \
  sed "/\[Service\]/a Environment=PATH=$PATH" | \
  sudo tee /etc/systemd/system/yeti.service >/dev/null
sudo cp "$INSTALL_DIR/deploy/yeti-updater.service" /etc/systemd/system/
sudo cp "$INSTALL_DIR/deploy/yeti-updater.timer" /etc/systemd/system/
chmod +x "$INSTALL_DIR/deploy/deploy.sh"

REPO_OWNER="${REPO%%/*}"

# Bootstrap config file if it doesn't exist
CONFIG_DIR="$HOME/.yeti"
CONFIG_FILE="$CONFIG_DIR/config.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
  mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_FILE" << CONF
{
  "githubOwners": ["${REPO_OWNER}"],
  "selfRepo": "${REPO}",
  "port": 9384,
  "discordBotToken": "",
  "discordChannelId": "",
  "discordAllowedUsers": [],
  "authToken": "",
  "maxClaudeWorkers": 2,
  "claudeTimeoutMs": 1200000,
  "maxCopilotWorkers": 1,
  "copilotTimeoutMs": 1200000,
  "maxCodexWorkers": 1,
  "codexTimeoutMs": 1200000,
  "jobAi": {},
  "intervals": {
    "issueWorkerMs": 300000,
    "issueRefinerMs": 300000,
    "ciFixerMs": 600000,
    "reviewAddresserMs": 300000,
    "autoMergerMs": 600000,
    "triageYetiErrorsMs": 600000,
    "planReviewerMs": 600000
  },
  "schedules": {
    "docMaintainerHour": 1,
    "repoStandardsHour": 2,
    "improvementIdentifierHour": 3,
    "issueAuditorHour": 5,
    "mkdocsUpdateHour": 4,
    "promptEvaluatorHour": 0
  },
  "logRetentionDays": 14,
  "logRetentionPerJob": 20,
  "pausedJobs": [],
  "skippedItems": [],
  "prioritizedItems": [],
  "allowedRepos": [],
  "includeForks": false,
  "enabledJobs": [],
  "reviewLoop": false,
  "maxPlanRounds": 3,
  "queueScanIntervalMs": 300000,
  "githubAppId": "",
  "githubAppInstallationId": "",
  "githubAppPrivateKeyPath": "",
  "githubAppClientId": "",
  "githubAppClientSecret": "",
  "externalUrl": "",
  "webhookSecret": ""
}
CONF
  chmod 600 "$CONFIG_FILE"
  log "Created $CONFIG_FILE — edit it to configure your instance"
  log "Available jobs for enabledJobs: issue-worker, issue-refiner, ci-fixer, review-addresser, doc-maintainer, auto-merger, repo-standards, improvement-identifier, issue-auditor, triage-yeti-errors, plan-reviewer, mkdocs-update"
fi

# Bootstrap env file if it doesn't exist (never overwrite user values)
ENV_FILE="$CONFIG_DIR/env"
if [[ ! -f "$ENV_FILE" ]]; then
  mkdir -p "$CONFIG_DIR"
  cat > "$ENV_FILE" << 'CONF'
# Environment variables loaded by the yeti systemd unit.
# Uncomment and set values as needed. These override config.json.

# Discord
# YETI_DISCORD_BOT_TOKEN=

# Dashboard auth
# YETI_AUTH_TOKEN=

# Copilot backend
# YETI_MAX_COPILOT_WORKERS=1
# YETI_COPILOT_TIMEOUT_MS=1200000

# Codex backend
# YETI_MAX_CODEX_WORKERS=1
# YETI_CODEX_TIMEOUT_MS=1200000

# Repo discovery
# YETI_INCLUDE_FORKS=false

# GitHub App (optional — gives Yeti a separate bot identity)
# YETI_GITHUB_APP_ID=
# YETI_GITHUB_APP_INSTALLATION_ID=
# YETI_GITHUB_APP_PRIVATE_KEY_PATH=

# OAuth (optional — enables GitHub sign-in for the dashboard)
# YETI_GITHUB_APP_CLIENT_ID=
# YETI_GITHUB_APP_CLIENT_SECRET=
# YETI_EXTERNAL_URL=

# Webhooks (optional — enables near-real-time job triggers)
# YETI_WEBHOOK_SECRET=
CONF
  chmod 600 "$ENV_FILE"
  log "Created $ENV_FILE — edit it to set environment overrides"
fi

# Enable and start
log "Enabling and starting services..."
sudo systemctl daemon-reload
sudo systemctl enable --now yeti
sudo systemctl enable --now yeti-updater.timer

log "Done! Yeti is running as $USER_NAME"
log "  Status:  sudo systemctl status yeti"
log "  Logs:    journalctl -u yeti -f"
