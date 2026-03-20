# Yeti - Codebase Analysis Report

## What It Does

**Yeti** is a self-hosted GitHub automation service — an AI-powered development multiplier. It polls your GitHub repos on intervals, uses the Claude CLI to analyze issues/PRs, and autonomously implements changes, fixes CI failures, addresses review feedback, and auto-merges PRs. The whole system runs as a systemd service with an HTTP dashboard.

## Tech Stack

- **TypeScript** (strict, ES2022) on **Node.js 22**
- **SQLite** (better-sqlite3, WAL mode) for task tracking
- **Baileys** for WhatsApp Web integration
- **ImapFlow/Nodemailer** for email monitoring
- External CLIs: `gh`, `claude`, `git`
- ~11,800 lines of TypeScript across ~47 source files

## Architecture

### Core Flow

```
GitHub Issues → [issue-refiner] plans → Human adds "Refined" label →
[issue-worker] implements PR → [ci-fixer] fixes failures →
[review-addresser] addresses feedback → [auto-merger] squash-merges
```

### 16 Jobs (14 scheduled, 1 event-driven, 1 startup-only)

| Job | Interval | Purpose |
|-----|----------|---------|
| issue-refiner | 5m | Plan implementations on open issues |
| issue-worker | 5m | Implement "Refined" issues as PRs |
| ci-fixer | 10m | Fix failing CI & merge conflicts |
| review-addresser | 5m | Push fixes for review comments |
| auto-merger | 10m | Merge Dependabot/approved/doc PRs |
| triage-kwyjibo-errors | 10m | Investigate prod bugs |
| triage-yeti-errors | 10m | Investigate internal errors |
| idea-suggester | Daily 4AM | Generate feature ideas → Slack |
| idea-collector | 30m | Poll Slack reactions → GH issues |
| doc-maintainer | Daily 1AM | Auto-update docs |
| repo-standards | Daily 2AM | Sync labels |
| improvement-identifier | Daily 3AM | Find & implement improvements |
| issue-auditor | Daily 5AM | Audit label state |
| runner-monitor | 10m | SSH to self-hosted runners |
| ubuntu-latest-scanner | Daily 6AM | Detect non-self-hosted runners |
| email-monitor | 5m | Convert emails → GH issues |
| whatsapp-handler | Event-driven | WhatsApp → GH issues |

### Key Patterns

- **Bounded Claude queue** — max 2 concurrent Claude processes with 20-min timeout
- **Git worktree isolation** — each task gets its own worktree
- **Skip-if-busy scheduling** — overlapping job ticks silently dropped
- **Rate-limit circuit breaker** — 60s cooldown on GitHub API rate limits
- **Crash recovery** — orphaned tasks cleaned up on restart
- **Auto-updates** — systemd timer checks for new releases every 60s with rollback

### HTTP Dashboard (port 3000)

Dashboard, job triggers, log viewer, config editor, WhatsApp pairing, health check endpoint, queue management (merge/skip/prioritize).

### Database (SQLite)

Three tables:

- **`tasks`** — Per-item work invocations (job, repo, item, status, worktree path, timestamps)
- **`job_runs`** — Scheduled job executions (UUID run_id, status, timing)
- **`job_logs`** — Log output per run (level, message, captured via AsyncLocalStorage)

Retention: 14 days + 20 runs per job (configurable).

### Configuration

Priority: environment variables > `~/.yeti/config.json` > hardcoded defaults. Live reload via HTTP POST `/config` (no restart required for most settings).

### HTTP Routes

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Dashboard — job status, triggers, queue overview |
| GET | `/health` | Health check (used by auto-updater for rollback) |
| GET | `/status` | JSON status — jobs, uptime, queue, integrations |
| GET/POST | `/login` | Token-based auth |
| POST | `/trigger/:job` | Manual job trigger |
| POST | `/pause/:job` | Toggle job pause/resume |
| POST | `/cancel` | Cancel in-flight Claude task |
| GET | `/queue` | Work queue page |
| POST | `/queue/merge` | Squash-merge a PR |
| POST | `/queue/skip` | Skip an issue/PR |
| POST | `/queue/unskip` | Remove skip |
| POST | `/queue/prioritize` | Prioritize an item |
| POST | `/queue/deprioritize` | Remove priority |
| GET | `/logs` | Log viewer with per-job filtering |
| GET | `/logs/:runId` | Run detail page |
| GET | `/logs/:runId/tail` | Live log tail (JSON) |
| GET | `/logs/issue` | Issue-specific logs |
| GET/POST | `/config` | Config viewer/editor |
| GET | `/config/api` | JSON config (sensitive fields masked) |
| GET | `/whatsapp` | WhatsApp status/pairing page |
| GET | `/whatsapp/pair` | SSE endpoint for QR codes |
| POST | `/whatsapp/unpair` | Clear WhatsApp auth |

### External Services

| Service | Purpose | Integration |
|---------|---------|-------------|
| GitHub API | Issue/PR management | `gh` CLI with retry/circuit-breaker |
| GitHub Actions | CI/CD | Check runs API, workflow logs |
| Slack | Notifications & ideas | Incoming webhooks + bot API |
| WhatsApp | Real-time issue creation | Baileys (XMPP-based client) |
| Gmail IMAP | Email monitoring | ImapFlow + nodemailer |
| OpenAI API | Voice transcription | Whisper for WhatsApp voice notes |
| Kwyjibo API | Game issue triage | Debug data for prod errors |
| Claude CLI | AI execution | Spawned subprocess, streamed I/O |

### Error Handling

- **Transient retry** — exponential backoff (1s/2s/4s, max 3 attempts) for `gh` CLI
- **Rate-limit circuit breaker** — 60s cooldown, Slack notification on trip/recovery
- **Error reporter** — 30-min per-fingerprint dedup, creates `[yeti-error]` issues in self-repo
- **Graceful shutdown** — SIGINT/SIGTERM drains running jobs (5-min timeout), terminates Claude processes (5s grace), closes DB
- **Crash recovery** — orphaned tasks cleaned up on startup, worktrees removed

---

## Security Analysis

### CRITICAL

#### SQL Injection in `pruneOldLogs()` — `src/db.ts:336-351`

The `retentionDays` value is string-interpolated directly into SQL:

```typescript
const cutoff = `datetime('now', '-${retentionDays} days')`;
// ...DELETE FROM job_runs WHERE started_at < ${cutoff}
```

While this value comes from config (not direct user input), anyone who can modify the config file or POST to `/config` could inject SQL. Should use parameterized queries.

### HIGH

#### 1. `--dangerously-skip-permissions` on Claude CLI — `src/claude.ts:400`

Claude is spawned with all permission checks disabled. Intentional for the use case, but means any prompt injection in an issue/PR body could lead to arbitrary code execution on the host.

#### 2. No HTTPS — `src/server.ts:120-122`

The HTTP server runs plain HTTP. Auth tokens transmitted in cleartext. Must be behind a reverse proxy with TLS.

#### 3. Hardcoded username "yeti" in deploy scripts — `deploy/deploy.sh:46,74,75`

Deploy script uses `sudo -u yeti` instead of a configurable user.

### MEDIUM

#### 4. Auth disabled by default — `src/config.ts:198`, `src/server.ts:50`

Empty `authToken` (the default) disables all authentication on the dashboard. Anyone with network access gets full control.

#### 5. No rate limiting on login — `src/server.ts:139-149`

No brute-force protection on the `/login` endpoint.

#### 6. Timing-safe comparison leaks token length — `src/server.ts:70-75`

`safeCompare()` uses `crypto.timingSafeEqual` but short-circuits on length mismatch, leaking token length via timing.

#### 7. Secret masking shows last 4 chars — `src/config.ts:314-319`

`maskValue()` returns `"****" + value.slice(-4)` — partial credential exposure in dashboard and `/config/api`.

#### 8. Error messages may contain secrets — `src/error-reporter.ts:47-108`

Stack traces, working directory paths, and Claude stdout are posted as GitHub issues. Could leak environment details.

#### 9. Service runs without sandboxing — `deploy/yeti.service`

No AppArmor/SELinux/seccomp restrictions. A compromise gives access to the user's full home directory (SSH keys, git credentials, etc).

#### 10. HTTP server binds to all interfaces — `src/server.ts:120`

Not restricted to localhost. Combined with no HTTPS and optional auth, this is a significant exposure.

#### 11. Weak config input validation — `src/server.ts:309-376`

The `/config` POST endpoint accepts runner configs without schema validation — malformed JSON arrays accepted as-is.

### LOW

#### 12. No Content-Security-Policy headers

HTML responses from the dashboard lack CSP headers, reducing defense-in-depth against XSS.

#### 13. Slack webhook in shell variables — `deploy/deploy.sh`

Webhook URL stored in a shell variable could appear in `ps` output.

---

## Recommendations (Priority Order)

1. **Fix the SQL interpolation** in `pruneOldLogs()` — validate `retentionDays` as a positive integer
2. **Deploy behind HTTPS** (nginx/Caddy with TLS termination) and bind to 127.0.0.1
3. **Require a non-empty auth token** — fail startup if not configured
4. **Add rate limiting** on `/login` (e.g., 5 attempts per minute per IP)
5. **Document the `--dangerously-skip-permissions` risk** and ensure the host is hardened (separate user, AppArmor profile, restricted home directory)
6. **Fix `maskValue()`** to fully mask secrets (don't show last 4 chars)
7. **Sanitize error output** before posting to GitHub issues
8. **Remove hardcoded username** from deploy scripts
9. **Add CSP headers** to dashboard HTML responses
10. **Validate config schema** (especially `runners` array) before accepting

---

## Systemic Risk

The most concerning systemic risk is the combination of **Claude running with `--dangerously-skip-permissions`** and **processing untrusted input from GitHub issues/PRs**. A crafted issue body could potentially achieve arbitrary code execution on the host. Network-level isolation and least-privilege system hardening are essential mitigations.
