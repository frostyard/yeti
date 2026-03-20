#!/usr/bin/env bash
set -euo pipefail

REPO="frostyard/yeti"
INSTALL_DIR="/opt/yeti"
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

# Bootstrap config file if it doesn't exist
CONFIG_DIR="$HOME/.yeti"
CONFIG_FILE="$CONFIG_DIR/config.json"
if [[ ! -f "$CONFIG_FILE" ]]; then
  mkdir -p "$CONFIG_DIR"
  cat > "$CONFIG_FILE" << 'CONF'
{
  "slackWebhook": "",
  "githubOwners": ["frostyard", "frostyard"],
  "selfRepo": "frostyard/yeti",
  "kwyjiboBaseUrl": "https://kwyjibo.vercel.app",
  "kwyjiboApiKey": ""
}
CONF
  chmod 600 "$CONFIG_FILE"
  log "Created $CONFIG_FILE — edit it to set your Slack webhook URL"
fi

# Bootstrap env file if it doesn't exist (never overwrite user values)
ENV_FILE="$CONFIG_DIR/env"
if [[ ! -f "$ENV_FILE" ]]; then
  mkdir -p "$CONFIG_DIR"
  cat > "$ENV_FILE" << 'CONF'
# Environment variables loaded by the yeti systemd unit.
# Uncomment and set values as needed.
# YETI_SLACK_WEBHOOK=https://hooks.slack.com/services/T.../B.../xxx
# KWYJIBO_BASE_URL=https://kwyjibo.vercel.app
# KWYJIBO_AUTOMATION_API_KEY=
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
