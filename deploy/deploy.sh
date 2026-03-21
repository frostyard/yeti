#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="/opt/yeti"
VERSION_FILE="$INSTALL_DIR/.current-version"
STAGING_DIR="$INSTALL_DIR/staging"
SKIP_FILE="$INSTALL_DIR/.skipped-versions"

log() { echo "$(date -Iseconds) [deploy] $*"; }

# Resolve the service user's home directory
CURRENT_UNIT="/etc/systemd/system/yeti.service"
if [[ -f "$CURRENT_UNIT" ]]; then
  YETI_USER=$(grep '^User=' "$CURRENT_UNIT" | cut -d= -f2)
  YETI_HOME=$(getent passwd "$YETI_USER" | cut -d: -f6)
else
  YETI_HOME="$HOME"
fi
CONFIG_FILE="$YETI_HOME/.yeti/config.json"
ENV_FILE="$YETI_HOME/.yeti/env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

# Resolve repo: .repo file (from release tarball) → config selfRepo → default
if [[ -f "$INSTALL_DIR/.repo" ]]; then
  REPO=$(cat "$INSTALL_DIR/.repo")
elif [[ -f "$CONFIG_FILE" ]]; then
  REPO=$(node -e "try{const c=JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf-8'));console.log(c.selfRepo||'frostyard/yeti')}catch{console.log('frostyard/yeti')}" 2>/dev/null)
else
  REPO="frostyard/yeti"
fi

CONFIG_PORT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf-8')).port||9384)}catch{console.log(9384)}" 2>/dev/null || echo "9384")
PORT="${PORT:-$CONFIG_PORT}"
HEALTH_URL="http://localhost:$PORT/health"

# 1. Get latest release tag
LATEST_TAG=$(sudo -u yeti gh release list -R "$REPO" --limit 1 --json tagName --jq '.[0].tagName')
if [[ -z "$LATEST_TAG" ]]; then
  log "No releases found"
  exit 0
fi

# 2. Compare with current version
CURRENT_TAG=""
if [[ -f "$VERSION_FILE" ]]; then
  CURRENT_TAG=$(cat "$VERSION_FILE")
fi

if [[ "$LATEST_TAG" == "$CURRENT_TAG" ]]; then
  log "Already up to date ($CURRENT_TAG)"
  exit 0
fi

# Check if this version was previously rolled back
if [[ -f "$SKIP_FILE" ]] && grep -qxF "$LATEST_TAG" "$SKIP_FILE"; then
  log "Skipping $LATEST_TAG (previously rolled back)"
  exit 0
fi

log "Updating from $CURRENT_TAG to $LATEST_TAG"

# 3. Download and extract
TMPFILE=$(sudo -u yeti mktemp /tmp/yeti-XXXXXX.tar.gz)
sudo -u yeti gh release download "$LATEST_TAG" -R "$REPO" -p "yeti.tar.gz" -O "$TMPFILE" --clobber
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
tar -xzf "$TMPFILE" -C "$STAGING_DIR"
rm -f "$TMPFILE"

# 4. Backup current dist
rm -rf "$INSTALL_DIR/dist.prev"
if [[ -d "$INSTALL_DIR/dist" ]]; then
  cp -r "$INSTALL_DIR/dist" "$INSTALL_DIR/dist.prev"
fi

# 5. Stop service before swapping files
log "Stopping yeti service..."
systemctl stop yeti || log "Warning: systemctl stop returned non-zero"

# 6. Replace dist, deploy, and node_modules with staging contents
#    Note: ~/.yeti/ (config.json, env) is user-managed and never touched by deployment.
rm -rf "$INSTALL_DIR/dist"
mv "$STAGING_DIR/dist" "$INSTALL_DIR/dist"
if [[ -d "$STAGING_DIR/deploy" ]]; then
  rm -rf "$INSTALL_DIR/deploy"
  mv "$STAGING_DIR/deploy" "$INSTALL_DIR/deploy"
  chmod +x "$INSTALL_DIR/deploy/deploy.sh"
fi
if [[ -d "$STAGING_DIR/node_modules" ]]; then
  rm -rf "$INSTALL_DIR/node_modules"
  mv "$STAGING_DIR/node_modules" "$INSTALL_DIR/node_modules"
fi

# 7. Reinstall systemd units (preserve User/Group/PATH from installed unit)
if [[ -f "$CURRENT_UNIT" ]]; then
  YETI_USER=$(grep '^User=' "$CURRENT_UNIT" | cut -d= -f2)
  YETI_PATH=$(grep '^Environment=PATH=' "$CURRENT_UNIT" | sed 's/^Environment=PATH=//')
  log "Reinstalling systemd units for $YETI_USER..."
  sed "s/User=yeti/User=$YETI_USER/;s/Group=yeti/Group=$YETI_USER/;s|/home/yeti/|$YETI_HOME/|" \
    "$INSTALL_DIR/deploy/yeti.service" | \
    sed "/\[Service\]/a Environment=PATH=$YETI_PATH" | \
    tee /etc/systemd/system/yeti.service >/dev/null
  cp "$INSTALL_DIR/deploy/yeti-updater.service" /etc/systemd/system/
  cp "$INSTALL_DIR/deploy/yeti-updater.timer" /etc/systemd/system/
  systemctl daemon-reload
fi

# 8. Start service
log "Starting yeti service..."
systemctl start yeti || log "Warning: systemctl start returned non-zero"

# 9. Health check (poll for up to 45s)
healthy=false
for i in $(seq 1 45); do
  if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 1
done

# 10. Rollback if unhealthy
if [[ "$healthy" != "true" ]]; then
  log "Health check failed after update — rolling back"

  if [[ -d "$INSTALL_DIR/dist.prev" ]]; then
    rm -rf "$INSTALL_DIR/dist"
    mv "$INSTALL_DIR/dist.prev" "$INSTALL_DIR/dist"
    systemctl restart yeti || log "Warning: rollback restart returned non-zero"

    rollback_healthy=false
    for i in $(seq 1 30); do
      if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
        rollback_healthy=true
        break
      fi
      sleep 1
    done

    if [[ "$rollback_healthy" == "true" ]]; then
      log "Rollback successful"
      echo "$LATEST_TAG" >> "$SKIP_FILE"
      log "Added $LATEST_TAG to skip list"
      exit 1
    else
      log "ERROR: Rollback also failed — manual intervention required"
      echo "$LATEST_TAG" >> "$SKIP_FILE"
      log "Added $LATEST_TAG to skip list"
      exit 1
    fi
  else
    log "ERROR: No previous version to rollback to"
    echo "$LATEST_TAG" >> "$SKIP_FILE"
    log "Added $LATEST_TAG to skip list"
    exit 1
  fi
fi

# 11. Success — record version and clean up
echo "$LATEST_TAG" > "$VERSION_FILE"
rm -rf "$INSTALL_DIR/dist.prev" "$STAGING_DIR"
log "Update to $LATEST_TAG complete"
