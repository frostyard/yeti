# Troubleshooting

When things go sideways in the cold, start here.

---

## Yeti won't start

**Check the service status:**

```bash
systemctl status yeti
journalctl -u yeti -n 50 --no-pager
```

**Common causes:**

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ERR_MODULE_NOT_FOUND` | Missing dependencies | Run `npm ci` in `/opt/yeti` |
| `EADDRINUSE` | Port 9384 already in use | Check for another Yeti process or change `port` in config |
| `EACCES` on `~/.yeti/` | Permission mismatch | Ensure the systemd user owns `~/.yeti/` |
| Crash loop | Bad config | Check `~/.yeti/config.json` for syntax errors |

---

## Jobs aren't running

**Nothing is happening at all:**

- Check `enabledJobs` in your config. An empty array means no jobs run. This is the most common oversight.
- Open the dashboard at `http://localhost:9384` and verify jobs are listed and not paused.

**A specific job isn't picking up work:**

1. Is the job in `enabledJobs`? It must be listed by name.
2. Is the job paused? Check the dashboard or `pausedJobs` in config.
3. Is the item in `skippedItems`? Check the queue page.
4. Is the previous run still active? Jobs use skip-if-busy --- they won't queue up if the last run hasn't finished.
5. Check the logs page (`/logs`) filtered by that job name for errors.

**Jobs run but produce no output:**

- The AI process may be timing out. Check logs for timeout messages.
- Increase `claudeTimeoutMs` or `copilotTimeoutMs` if tasks are consistently hitting the 20-minute default.

---

## Issues aren't being planned

**issue-refiner isn't picking up an issue:**

1. Does the issue have the `Needs Refinement` label? Regular issues require it.
2. Is `issue-refiner` in `enabledJobs`?
3. Is the repo in `allowedRepos` (or is `allowedRepos` set to `null` for all repos)?
4. Is the issue in `skippedItems`?
5. Check `/logs` for the issue-refiner job --- look for errors or "no work found" messages.

**Plan quality is poor:**

This is a repo configuration issue, not a Yeti issue. See the [Optimization](optimization.md) page. The short version: add a `CLAUDE.md` with build commands, architecture overview, and coding conventions.

---

## PRs aren't being created

**issue-worker runs but no PR appears:**

1. **Tree-diff guard:** The worker checks that its changes actually differ from the base branch. If Claude makes no effective changes (empty diff), no PR is created. Check logs for "no tree diff" messages.
2. **Duplicate PR guard:** If an open PR for the same issue already exists, the worker skips it. Check for existing PRs.
3. **Claude errors:** The Claude process may have failed. Check the run log for the specific issue.

**PR is created but immediately fails CI:**

- This is normal --- the [ci-fixer](../reference/jobs/ci-fixer.md) will pick it up on its next cycle.
- If ci-fixer can't fix it, it'll file a `[ci-unrelated]` issue if the failure isn't caused by the PR's changes.

---

## CI fixer isn't working

**ci-fixer runs but doesn't fix failures:**

1. The fixer classifies failures as "related" (caused by PR changes) or "unrelated" (pre-existing). Check the PR comments for its classification.
2. For related failures, Claude reads the CI logs and attempts a fix. If the logs are too large or unclear, the fix may fail.
3. For unrelated failures, the fixer files a `[ci-unrelated]` issue rather than attempting a fix on the PR.

**Merge conflicts aren't being resolved:**

- The ci-fixer handles conflicts by merging the base branch and using Claude to resolve markers.
- If the conflict is too complex, Claude may produce an incorrect resolution. Review the commit.

---

## Auto-merger won't merge

The [auto-merger](../reference/jobs/auto-merger.md) has strict criteria. A PR must match one of these categories:

**Dependabot PRs:**

- All checks must be passing. No exceptions.

**Doc PRs (`yeti/docs-*`):**

- Only `.md` or `yeti/` files can be changed.
- Checks must pass OR no checks must be configured.

**Issue PRs (`yeti/issue-*`):**

- A valid LGTM comment must exist.
- The LGTM must be posted *after* the latest commit (stale approvals don't count).

If none of these apply, the PR requires manual merge.

---

## Dashboard issues

**Can't access the dashboard:**

- Verify Yeti is running: `curl localhost:9384/health`
- If `authToken` is set, you need to log in at `/login`.
- If accessing remotely, check firewall rules for port 9384.

**Queue shows stale data:**

- The queue is populated by the label scanner, which runs every 5 minutes (`queueScanIntervalMs`).
- If [webhooks](../getting-started/github-app.md#webhooks-optional) are configured, the queue cache updates in real-time when labels are added or removed on GitHub.
- Trigger a manual refresh by visiting `/queue` --- the page fetches fresh data on load.
- If labels were changed outside Yeti (manually on GitHub) and webhooks are not configured, wait for the next scan cycle.

---

## Discord bot not responding

1. Verify `discordBotToken` and `discordChannelId` are set in config.
2. Check that the bot has the required intents: Guilds, GuildMessages, MessageContent.
3. Verify your Discord user ID is in `discordAllowedUsers`.
4. Check Yeti logs for Discord connection errors: `journalctl -u yeti | grep -i discord`
5. Ensure the bot has permission to read and send messages in the configured channel.

---

## Rate limiting

**GitHub API rate limit errors:**

Yeti uses a circuit breaker with a 60-second cooldown. When rate-limited, all jobs pause API calls for 60 seconds, then resume. This is automatic.

If you're hitting rate limits frequently:

- Increase job intervals to reduce API call frequency.
- Reduce the number of repos being scanned (`allowedRepos`).
- Check that `queueScanIntervalMs` isn't set too low.

---

## Auto-updater issues

**Yeti isn't updating:**

```bash
systemctl status yeti-updater.timer
systemctl status yeti-updater.service
journalctl -u yeti-updater -n 20 --no-pager
```

- The timer checks every 60 seconds.
- Updates require `gh` CLI to be authenticated as the service user.
- If a health check fails after update, the updater rolls back automatically.

**Rolled back after update:**

- Check `journalctl -u yeti-updater` for the rollback reason.
- Usually means the new version's health check (`GET /health`) failed within the timeout window.
- The previous version is restored and Yeti restarts.

---

## Worktree cleanup

Worktrees are created at `~/.yeti/worktrees/` and cleaned up in `finally` blocks after each job run. On startup, Yeti also cleans up orphaned worktrees from prior crashes.

**If worktrees are accumulating:**

```bash
ls ~/.yeti/worktrees/*/*/
```

- Orphaned worktrees usually mean a job crashed without cleanup.
- Restarting Yeti will trigger crash recovery, which cleans them up.
- You can safely delete the contents of `~/.yeti/worktrees/` while Yeti is stopped.

---

## OAuth / GitHub sign-in

**"Sign in with GitHub" button doesn't appear:**

- All three config fields must be set: `githubAppClientId`, `githubAppClientSecret`, and `externalUrl`.
- These fields require a restart --- changing them via the dashboard config editor won't take effect until you restart Yeti.

**Callback URL mismatch error from GitHub:**

- The callback URL registered in your GitHub App settings must exactly match `{externalUrl}/auth/callback`.
- Check for protocol mismatch (`http` vs `https`), trailing slashes, and port numbers.

**"Not an org member" error after signing in:**

- OAuth checks that the GitHub user belongs to at least one organization in `githubOwners`.
- The GitHub API's org membership endpoint only works for actual organizations, not personal usernames. If `githubOwners` contains only personal usernames, all OAuth logins will be denied.
- The user must be a **member** of the org (not just a collaborator on individual repos).

**`externalUrl` misconfiguration:**

- Must start with `http://` or `https://`. Trailing slashes are stripped automatically.
- Must match the URL users actually access (what's in the browser address bar), not an internal hostname.
- If behind a reverse proxy, use the public-facing URL, not `localhost`.

**Session expired / forced re-login:**

- Sessions last 24 hours. After that, users must sign in again.
- Changing `githubAppClientSecret` invalidates all existing sessions.

---

## Webhooks not triggering

**Jobs don't run immediately after labeling an issue:**

1. Is `webhookSecret` set in config? The endpoint returns 404 without it.
2. Is the webhook active in your GitHub App settings? Check **Settings > Developer settings > GitHub Apps > your app > Webhook**.
3. Are the right events subscribed? You need **Issues** and **Check runs**.
4. Check GitHub's webhook delivery log (App settings > Advanced > Recent Deliveries) for failed deliveries or signature mismatches.
5. Verify Yeti's external URL is reachable from GitHub. The webhook URL is auto-configured on startup.

**Webhook events arrive but jobs are skipped:**

- The job must be in `enabledJobs`. Webhook events for disabled jobs are silently ignored.
- If the job is already running, the event is skipped. Polling catches it on the next cycle.
- The repo must be in `allowedRepos` (or `allowedRepos` must be `null`).

---

## Getting more information

- **Dashboard logs:** `/logs` with filtering by job name, status, and search text.
- **System logs:** `journalctl -u yeti -f` for live tailing.
- **Log level:** Set `logLevel` in config to control verbosity. Values: `debug` (default), `info`, `warn`, `error`. Debug-level logs are suppressed when a higher level is set. The `error` level always executes (it triggers notifications).
- **Health check:** `curl localhost:9384/health` for a quick alive check.
- **Status endpoint:** `curl localhost:9384/status` for detailed JSON with job schedules, uptime, queue state, and integration status.
