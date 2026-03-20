#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="/opt/yeti"

log() { echo "==> $*"; }

log "Stopping and disabling services..."
sudo systemctl stop yeti yeti-updater.timer yeti-updater.service 2>/dev/null || true
sudo systemctl disable yeti yeti-updater.timer yeti-updater.service 2>/dev/null || true

log "Removing systemd units..."
sudo rm -f /etc/systemd/system/yeti.service \
           /etc/systemd/system/yeti-updater.service \
           /etc/systemd/system/yeti-updater.timer
sudo systemctl daemon-reload

log "Removing $INSTALL_DIR..."
sudo rm -rf "$INSTALL_DIR"

log "Done — Yeti has been uninstalled"
