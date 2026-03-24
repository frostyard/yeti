# HTTP API

Yeti exposes an HTTP server (default port `9384`) that serves both the web dashboard and a set of API endpoints for monitoring and control.

---

## Authentication

When `authToken` is configured or GitHub OAuth is enabled, most routes require authentication. Auth is provided via any of:

- **Header:** `Authorization: Bearer <token>` (when `authToken` is set)
- **Cookie:** `yeti_token` (set by the token login form, when `authToken` is set)
- **Cookie:** `yeti_session` (set by GitHub OAuth sign-in, when OAuth is configured)

The `/health`, `/status`, `/login`, `POST /login`, and `/auth/*` routes are accessible without authentication.

---

## Routes

### Public Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check. Returns `{"status": "ok", "version": "..."}` |
| `GET` | `/status` | System status with job states, uptime, queue stats, and integration status (JSON) |
| `GET` | `/login` | Login page (HTML). Redirects to `/` if auth is disabled |
| `POST` | `/login` | Submit auth token via form. Sets `yeti_token` cookie on success |
| `GET` | `/auth/github` | Redirect to GitHub OAuth authorization page. Sets a CSRF state cookie |
| `GET` | `/auth/callback` | OAuth callback. Exchanges code for user identity, checks org membership, sets `yeti_session` cookie |
| `GET` | `/auth/logout` | Clears session cookie and redirects to `/login` |

### Dashboard (Auth Required)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Main dashboard -- job status, worker queues, running tasks, schedule info |
| `GET` | `/jobs` | Jobs page -- all registered jobs with backend, model, schedule, status, and controls |
| `GET` | `/repos` | Repos page -- configured repositories with active queue items and recent completed tasks |

### Repo Management (Auth Required)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/repos/add` | Add a repo to `allowedRepos`. Body: `{"repo": "repo-name"}`. Returns `{"result": "added"}` |

### Job Control (Auth Required)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/trigger/:job` | Manually trigger a job. Returns `200` (started), `409` (already running), or `404` (unknown job) |
| `POST` | `/pause/:job` | Toggle pause/resume for a job. Persists to config file |
| `POST` | `/cancel` | Cancel the currently-running Claude task (SIGTERM escalation) |

### Queue Management (Auth Required)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/queue` | Work queue page -- items grouped by "My Attention" and "Yeti's Attention" |
| `POST` | `/queue/merge` | Squash-merge a PR. Body: `{"repo": "owner/name", "prNumber": 123}` |
| `POST` | `/queue/skip` | Skip an issue/PR. Body: `{"repo": "owner/name", "number": 123}` |
| `POST` | `/queue/unskip` | Remove a skip. Body: `{"repo": "owner/name", "number": 123}` |
| `POST` | `/queue/prioritize` | Mark item as high-priority. Body: `{"repo": "owner/name", "number": 123}` |
| `POST` | `/queue/deprioritize` | Remove priority. Body: `{"repo": "owner/name", "number": 123}` |

### Logs (Auth Required)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/logs` | Log viewer. Supports query params: `?job=<name>` to filter by job, `?search=<term>` to search by item |
| `GET` | `/logs/:runId` | Individual run detail page with full logs and associated tasks |
| `GET` | `/logs/:runId/tail` | Live log tail (JSON). Supports `?after=<id>` for polling. Returns `{status, completed_at, logs: [...]}` |
| `GET` | `/logs/issue` | Issue-specific logs. Requires `?repo=owner/name&number=123` |

### Configuration (Auth Required)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/config` | Config editor page (HTML form). Supports `?saved=1` flash message |
| `POST` | `/config` | Update config fields via form submission. Triggers live reload. Redirects to `/config?saved=1` |
| `GET` | `/config/api` | Current config as JSON with sensitive fields masked (auth token, Discord bot token show `****<last 4 chars>`) |

---

## Response Formats

### Health Check

```json
{
  "status": "ok",
  "version": "v2026-03-15.1"
}
```

### Status

```json
{
  "status": "ok",
  "startedAt": "2026-03-15T10:00:00.000Z",
  "uptime": 3600,
  "jobs": {
    "issue-refiner": false,
    "issue-worker": true
  },
  "pausedJobs": ["improvement-identifier"],
  "claudeQueue": { "pending": 0, "active": 1 },
  "copilotQueue": { "pending": 0, "active": 0 },
  "runningTasks": [
    {
      "jobName": "issue-worker",
      "repo": "frostyard/yeti",
      "itemNumber": 42,
      "startedAt": "2026-03-15T10:30:00"
    }
  ],
  "jobSchedules": {
    "issue-refiner": {
      "intervalMs": 300000,
      "lastCompletedAt": "2026-03-15T10:25:00Z",
      "nextRunIn": 180000
    },
    "doc-maintainer": {
      "scheduledHour": 1,
      "lastCompletedAt": "2026-03-15T01:05:00Z",
      "nextRunIn": 52200000
    }
  },
  "discord": {
    "connected": true,
    "guildName": "Frostyard"
  }
}
```

### Trigger Job

```json
{ "result": "started" }
```

Possible `result` values: `"started"`, `"already-running"`, `"unknown"`.

### Cancel Task

```json
{ "result": "cancelled" }
```

Possible `result` values: `"cancelled"`, `"no-active-task"`.

---

## Queue Categories

The queue page groups items into two sections:

**My Attention** (items waiting for a human):

- `ready` -- Issues with plans ready for review

**Yeti's Attention** (items Yeti is working on or will work on):

- `needs-refinement` -- Issues needing plans
- `refined` -- Issues approved for implementation
- `needs-review-addressing` -- PRs with unaddressed review comments
- `auto-mergeable` -- PRs ready to auto-merge
- `needs-triage` -- Error issues needing investigation
- `needs-plan-review` -- Plans awaiting adversarial review
