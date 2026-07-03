# Deploy Unit Self-Heal

When a release adds a new systemd unit, do not rely only on the normal post-download unit reinstall block in `deploy/deploy.sh`. The release that introduces the unit is first applied by the previous `deploy.sh`, and later checks can exit early as "Already up to date" before reaching the reinstall block.

Install and enable the new unit in an idempotent self-heal block near the top of the new `deploy.sh`, before version-comparison early exits, so existing installations converge on the first no-op updater run after the release lands.
