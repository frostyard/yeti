# Deployment

Yeti runs as a Linux systemd service from `/opt/yeti` by default and keeps
operator state under `~/.yeti`. Release tarballs are self-describing: CI writes
the source repository (`owner/repo`) into an embedded `.repo` file, and
`install.sh` / `deploy.sh` use it before falling back to `selfRepo` in config
or `frostyard/yeti`. This lets forked Yeti instances self-update from their
own releases on the same host.

Auto-updates are driven by `yeti-updater.timer`, which checks hourly, downloads
the latest `yeti.tar.gz` release, signals quiesce, waits for active jobs to
drain up to a cap, swaps `dist/`, `deploy/`, and `node_modules/`, restarts the
service, health-checks it, and rolls back on failure. The dashboard's
"Check for updates" action writes `~/.yeti/update-check-requested`; the
root-owned `yeti-updater-trigger.path` unit watches that sentinel and starts
`yeti-updater.service`.

When a release adds a new systemd unit, do not rely only on the normal
post-download unit reinstall block in `deploy.sh`: the release introducing the
unit is first applied by the previous deploy script, and later checks can exit
early as "Already up to date." New deploy scripts should install critical new
units idempotently near the top, before version-comparison early exits, so a
later no-op update check self-heals existing installs. The manual update-check
path unit follows this pattern.

`deploy.sh` resolves the service user dynamically by reading `User=` from
`/etc/systemd/system/yeti.service`, then derives the home directory with
`getent passwd`. Avoid hardcoding the username in deployment logic.

## Runtime Layout

```
~/.yeti/
├── config.json             Configuration file
├── env                     Environment overrides loaded by systemd
├── yeti.db                 SQLite database
├── last-version            Last announced version
├── update-check-requested  Manual update-check sentinel watched by systemd
├── repos/
│   └── <owner>/<repo>/     Main clone per repository
└── worktrees/
    └── <owner>/<repo>/<job>/<branch>/

/opt/yeti/
├── .repo                   Source repository, e.g. frostyard/yeti
├── .current-version        Currently deployed version tag
├── dist/                   Compiled TypeScript output
├── deploy/                 Deployment scripts and systemd units
└── node_modules/           Runtime dependencies
```
