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
  YETI_USER="${SUDO_USER:-$(whoami)}"
  YETI_HOME="$HOME"
fi
CONFIG_FILE="$YETI_HOME/.yeti/config.json"
ENV_FILE="$YETI_HOME/.yeti/env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi
UPDATE_CHECK_FILE="$YETI_HOME/.yeti/update-check-requested"
rm -f "$UPDATE_CHECK_FILE" 2>/dev/null || true

# Keep the manual update-check path unit installed and active even on no-op
# checks, so older installs self-heal after the release that introduces it.
TRIGGER_PATH_UNIT="$INSTALL_DIR/deploy/yeti-updater-trigger.path"
if [[ -f "$TRIGGER_PATH_UNIT" ]]; then
  sed "s|/home/yeti/|$YETI_HOME/|" "$TRIGGER_PATH_UNIT" | \
    tee /etc/systemd/system/yeti-updater-trigger.path >/dev/null
  systemctl daemon-reload
  systemctl enable --now yeti-updater-trigger.path || \
    log "Warning: could not enable yeti-updater-trigger.path"
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
LATEST_TAG=$(sudo -u "$YETI_USER" gh release list -R "$REPO" --limit 1 --json tagName --jq '.[0].tagName')
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

# 2.5 Quiesce: tell the running daemon to stop starting new jobs so in-flight work
#     can drain before we restart. The daemon clears this sentinel on startup; the
#     EXIT trap removes it if we abort before restarting.
QUIESCE_FILE="$YETI_HOME/.yeti/quiesce"
cleanup_quiesce() { rm -f "$QUIESCE_FILE" 2>/dev/null || true; }
trap cleanup_quiesce EXIT
sudo -u "$YETI_USER" bash -c "echo '$LATEST_TAG' > '$QUIESCE_FILE'" || log "Warning: could not write quiesce sentinel"
log "Quiesce signalled — new jobs deferred while draining"

# 3. Download and extract
TMPFILE=$(sudo -u "$YETI_USER" mktemp /tmp/yeti-XXXXXX.tar.gz)
sudo -u "$YETI_USER" gh release download "$LATEST_TAG" -R "$REPO" -p "yeti.tar.gz" -O "$TMPFILE" --clobber
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
tar -xzf "$TMPFILE" -C "$STAGING_DIR"
rm -f "$TMPFILE"

# 4. Backup current dist
rm -rf "$INSTALL_DIR/dist.prev"
if [[ -d "$INSTALL_DIR/dist" ]]; then
  cp -r "$INSTALL_DIR/dist" "$INSTALL_DIR/dist.prev"
fi

# 4.5 Wait for in-flight jobs to drain (bounded by UPDATE_MAX_WAIT). A hung/very
#      long job can't block updates forever — after the cap we proceed and the
#      service stop's own drain bounds the rest.
UPDATE_MAX_WAIT="${UPDATE_MAX_WAIT:-1800}"   # seconds
QUIESCE_POLL="${QUIESCE_POLL:-15}"           # seconds between polls
waited=0
while true; do
  health=$(curl -fsS --max-time 5 "$HEALTH_URL" 2>/dev/null || echo "")
  if [[ -z "$health" ]]; then
    log "Health endpoint unreachable — nothing to drain, proceeding"
    break
  fi
  active=$(echo "$health" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).activeTasks??0)}catch{console.log(0)}})" 2>/dev/null || echo 0)
  if [[ "$active" == "0" ]]; then
    log "Daemon idle — proceeding with deploy"
    break
  fi
  if [[ "$waited" -ge "$UPDATE_MAX_WAIT" ]]; then
    log "Quiesce cap reached (${UPDATE_MAX_WAIT}s) with $active active job(s) — proceeding; service-stop drain will bound the rest"
    break
  fi
  log "Draining — $active active job(s) (${waited}s/${UPDATE_MAX_WAIT}s)"
  sleep "$QUIESCE_POLL"
  waited=$((waited + QUIESCE_POLL))
done

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
