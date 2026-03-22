# Installation

Yeti installs to `/opt/yeti` and runs as a systemd service. The install script handles everything: downloading the latest release, setting up systemd units, and bootstrapping your configuration. The whole process takes a few minutes.

## Prerequisites

Before you begin, make sure the following are available on your Linux host:

| Requirement | Why |
|---|---|
| **Node.js 22+** | Yeti's runtime. ESM, strict TypeScript compiled to JS. |
| **`gh` CLI** | All GitHub interaction goes through the `gh` CLI. Must be authenticated (`gh auth login`). |
| **`claude` CLI** | Yeti delegates AI work to the Claude CLI. Must be authenticated (`claude auth login`). |
| **Linux with systemd** | Yeti runs as a managed service with auto-updates via a systemd timer. |

Verify your setup:

```bash
node --version    # v22.x or later
gh auth status    # Must show "Logged in"
claude --version  # Must be installed and authenticated
```

## Install

A single command downloads the latest release and sets everything up:

```bash
curl -fsSL https://raw.githubusercontent.com/frostyard/yeti/main/deploy/install.sh | bash
```

Or, if you prefer to inspect the script first:

```bash
gh release download -R frostyard/yeti --pattern 'yeti.tar.gz' -O /tmp/yeti.tar.gz
sudo mkdir -p /opt/yeti && sudo chown $(whoami) /opt/yeti
tar -xzf /tmp/yeti.tar.gz -C /opt/yeti
/opt/yeti/deploy/install.sh
```

### What the install script does

1. **Creates `/opt/yeti`** owned by your user (no dedicated service account needed)
2. **Downloads the latest release tarball** via `gh release download` and extracts it
3. **Installs three systemd units:**
    - `yeti.service` --- the main daemon
    - `yeti-updater.service` --- the update script
    - `yeti-updater.timer` --- triggers the updater on a schedule
4. **Bootstraps `~/.yeti/config.json`** with sensible defaults if the file does not already exist
5. **Creates `~/.yeti/env`** for environment variable overrides
6. **Enables and starts** both the service and the auto-updater timer

!!! note
    The install script patches the systemd unit to run as your current user with your current `$PATH`. This ensures `gh`, `claude`, and `node` are all available to the service.

## Post-install

Start Yeti and verify it is running:

```bash
sudo systemctl start yeti
curl -s http://localhost:9384/health
```

A healthy response confirms the daemon is up. Open `http://localhost:9384` in a browser to see the dashboard.

Check the logs if anything looks off:

```bash
journalctl -u yeti -f
```

## Auto-updates

Yeti keeps itself current. The `yeti-updater.timer` fires every 60 seconds and runs the deploy script, which:

1. Checks for a new release tag on GitHub
2. Downloads and extracts the new tarball to a staging directory
3. Backs up the current `dist/` directory
4. Stops the service, swaps in the new files, starts the service
5. Polls the health endpoint for up to 45 seconds
6. **Rolls back automatically** if the health check fails --- restores the previous `dist/`, restarts, and adds the bad version to a skip list so it will not be retried

Your configuration in `~/.yeti/` is never touched by updates. Only `dist/`, `deploy/`, and `node_modules/` are replaced.

You can check the current version and updater status at any time:

```bash
cat /opt/yeti/.current-version
systemctl status yeti-updater.timer
```

## Next steps

Yeti is running, but it will not do anything useful until you configure which jobs to enable and which repositories to watch.

[Configure Yeti](configuration.md){ .md-button .md-button--primary }
