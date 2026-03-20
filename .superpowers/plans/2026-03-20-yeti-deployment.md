# Yeti Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy Yeti to a Debian Incus container from an empty private GitHub repo, with Discord integration and Tailscale Serve for dashboard access.

**Architecture:** CI/CD-first — fix workflows for GitHub-hosted runners, push code to create the first release, then bootstrap the server using install.sh. Discord bot for notifications/commands, Tailscale Serve for secure HTTPS dashboard.

**Tech Stack:** Node.js 22, TypeScript, systemd, GitHub Actions, Discord.js, Tailscale

**Spec:** `.superpowers/specs/2026-03-20-yeti-deployment-guide-design.md`

---

### Task 1: Fix CI/CD Workflows and Push to GitHub

This is the only code change. Everything after this is manual server/browser operations.

**Files:**
- Modify: `.github/workflows/ci.yml:12` — change `runs-on`
- Modify: `.github/workflows/release.yml:16` — change `runs-on`

- [ ] **Step 1: Fix CI workflow**

In `.github/workflows/ci.yml`, change line 11:
```yaml
# Before
    runs-on: self-hosted
# After
    runs-on: ubuntu-latest
```

- [ ] **Step 2: Fix release workflow**

In `.github/workflows/release.yml`, change line 17:
```yaml
# Before
    runs-on: self-hosted
# After
    runs-on: ubuntu-latest
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml
git commit -m "fix: use GitHub-hosted runners for CI and release workflows"
```

- [ ] **Step 4: Add remote and push**

```bash
git remote add origin git@github.com:frostyard/yeti.git
git push -u origin main
```

- [ ] **Step 5: Verify workflows**

Check GitHub Actions tab at `https://github.com/frostyard/yeti/actions`:
- Both CI and Release workflows should be running
- Wait for both to complete green
- Check GitHub Releases — `yeti.tar.gz` should be attached to a `v2026-03-20.1` release

---

### Task 2: Upgrade Node.js on Server (manual, on server)

SSH into the server as `yeti`.

- [ ] **Step 1: Upgrade Node.js from 20 to 22**

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs
```

- [ ] **Step 2: Verify**

```bash
node --version
# Expected: v22.x.x
```

---

### Task 3: Authenticate CLIs (manual, on server)

Still SSH'd as `yeti`.

- [ ] **Step 1: Authenticate GitHub CLI**

```bash
gh auth login
```

Interactive flow. Accept default scopes (includes `repo`, required for private repo access). Choose HTTPS or SSH as preferred.

- [ ] **Step 2: Verify gh auth**

```bash
gh repo view frostyard/yeti
# Should show repo details, not a 404
```

- [ ] **Step 3: Authenticate Claude CLI**

```bash
claude
```

Interactive login flow. Follow the prompts to authenticate.

- [ ] **Step 4: Verify claude auth**

```bash
claude --version
# Should print version without auth errors
```

---

### Task 4: Install Yeti and Configure (manual, on server)

Still SSH'd as `yeti`.

- [ ] **Step 1: Run install.sh**

```bash
gh api repos/frostyard/yeti/contents/deploy/install.sh --jq .content | base64 -d | bash
```

Expected output ends with:
```
==> Done! Yeti is running as yeti
==>   Status:  sudo systemctl status yeti
==>   Logs:    journalctl -u yeti -f
```

- [ ] **Step 2: Verify install**

```bash
ls /opt/yeti/dist/main.js          # Compiled entry point exists
cat /opt/yeti/.current-version     # Shows v2026-03-20.1
sudo systemctl status yeti          # Active (may have Slack warning in logs, that's expected)
```

- [ ] **Step 3: Create Discord bot (in browser)**

1. Go to https://discord.com/developers/applications → **New Application** → name it "Yeti"
2. Navigate to **Bot** section → **Add Bot**
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**
4. Click **Reset Token** → copy the **bot token** (save it, you can't see it again)
5. Navigate to **OAuth2 → URL Generator**:
   - Scopes: `bot`
   - Bot Permissions: `View Channels`, `Send Messages`, `Read Message History`
6. Copy the generated URL → open it → invite the bot to your Discord server
7. In your Discord server, create a private `#yeti` channel and add the bot to it
8. Enable Developer Mode: User Settings → Advanced → Developer Mode
9. Right-click the `#yeti` channel → **Copy Channel ID** (save it)
10. Right-click your Discord user → **Copy User ID** (save it)

- [ ] **Step 4: Edit config**

```bash
nano ~/.yeti/config.json
```

Update these four fields (leave everything else at defaults):
- `"discordBotToken"`: paste bot token from step 3.4
- `"discordChannelId"`: paste channel ID from step 3.9
- `"discordAllowedUsers"`: `["<your user ID from step 3.10>"]`
- `"authToken"`: generate a strong random string (e.g. `openssl rand -hex 32`)

Save and exit.

- [ ] **Step 5: Restart Yeti**

Discord config is immutable — requires restart:

```bash
sudo systemctl restart yeti
```

- [ ] **Step 6: Verify Discord connection**

```bash
journalctl -u yeti -n 20 --no-pager
# Look for: "[discord] Connected" or similar
```

---

### Task 5: Set Up Tailscale Serve (manual, on server)

Still SSH'd as `yeti`.

- [ ] **Step 1: Set hostname**

```bash
sudo tailscale set --hostname=yeti
```

This renames the machine in your Tailnet to `yeti`.

- [ ] **Step 2: Configure Tailscale Serve**

```bash
sudo tailscale serve --bg http://localhost:9384
```

This sets up a persistent HTTPS reverse proxy. Tailscale handles TLS automatically.

- [ ] **Step 3: Verify**

```bash
tailscale serve status
# Should show https -> http://localhost:9384
```

---

### Task 6: Verify Everything (manual)

- [ ] **Step 1: Health check (on server)**

```bash
curl http://localhost:9384/health
# Expected: {"status":"ok","version":"v2026-03-20.1"}
```

- [ ] **Step 2: Systemd services (on server)**

```bash
sudo systemctl status yeti              # Active and running
sudo systemctl status yeti-updater.timer # Active, next trigger scheduled
```

- [ ] **Step 3: Logs (on server)**

```bash
journalctl -u yeti -n 50 --no-pager
```

Expect to see: DB initialized, orphan recovery, jobs registered, scheduler started, HTTP server listening on 9384, Discord connected.

- [ ] **Step 4: Dashboard (in browser)**

Open `https://yeti.<tailnet>.ts.net` in a browser:
- Log in with your `authToken`
- Verify all jobs listed with their states
- Verify queue page loads
- Verify logs page loads
- Verify config page shows settings (tokens masked)

- [ ] **Step 5: Discord (in Discord)**

Send `!yeti status` in your `#yeti` channel. The bot should reply with job states, uptime, and queue size.

Future pushes to `main` will automatically create releases, and the updater will download and deploy them within 60 seconds, with health-check rollback on failure.

---

## Post-Deployment Reference

| Operation | Command |
|---|---|
| View logs | `journalctl -u yeti -f` or dashboard logs page |
| Trigger job | `!yeti trigger <job>` in Discord |
| Pause job | `!yeti pause <job>` in Discord |
| Resume job | `!yeti resume <job>` in Discord |
| Job status | `!yeti status` in Discord |
| Config change | Edit `~/.yeti/config.json` (live-reloaded) or dashboard config page |
| Restart (immutable config) | `sudo systemctl restart yeti` |
| Deploy new code | Push to `main` — auto-released and auto-deployed |
| Manual rollback | `sudo systemctl stop yeti && rm -rf /opt/yeti/dist && mv /opt/yeti/dist.prev /opt/yeti/dist && sudo systemctl start yeti` |
