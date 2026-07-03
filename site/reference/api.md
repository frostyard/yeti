# HTTP API

Yeti exposes an HTTP server (default port `9384`) that serves both the web dashboard and a JSON API under `/api/*`. The dashboard is a React/Vite single-page app that talks exclusively to these JSON endpoints — there are no server-rendered HTML pages except the SPA shell and OAuth redirects.

---

## Authentication

Auth is enabled when `authToken` is set **or** GitHub OAuth is configured (either or both). When enabled, all `/api/*` routes except the public ones below require authentication, provided via any of:

- **Header:** `Authorization: Bearer <authToken>` (when `authToken` is set)
- **Cookie:** `yeti_token` (set by `POST /api/login`, when `authToken` is set)
- **Cookie:** `yeti_session` (set by GitHub OAuth sign-in, when OAuth is configured)

Protected `/api/*` routes return a JSON `401` (not an HTML redirect) when unauthenticated. The following routes never require auth: `GET /health`, `GET /api/session`, `POST /api/login`, `POST /api/logout`, the `/auth/*` OAuth routes, and `POST /webhooks/github`.

---

## Public Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check and deploy drain signal. Returns `{status, version, activeTasks, updatePending}` |
| `GET` | `/api/session` | Auth probe — never returns 401. Reports whether auth is enabled, whether the caller is authenticated, and which methods are available |
| `POST` | `/api/login` | Submit auth token as JSON `{"token": "..."}`. Sets the `yeti_token` cookie on success |
| `POST` | `/api/logout` | Clears the `yeti_token` and `yeti_session` cookies |
| `GET` | `/auth/github` | Redirect to GitHub OAuth authorization. Sets a CSRF state cookie |
| `GET` | `/auth/callback` | OAuth callback. Exchanges code for identity, checks org membership, sets `yeti_session` cookie |
| `GET` | `/auth/logout` | Clears the session cookie and redirects to `/login` |
| `POST` | `/webhooks/github` | GitHub webhook receiver. HMAC-SHA256 verified via `X-Hub-Signature-256`. Returns 404 when `webhookSecret` is unset |

---

## Data Routes (Auth Required, GET)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/overview` | Overview payload — job states, worker queues, running tasks, schedules, integrations, and host system stats |
| `GET` | `/api/jobs` | All registered jobs with backend, model, schedule, status, and controls metadata |
| `GET` | `/api/queue` | Work queue grouped by human vs. Yeti attention, with tier-blocked annotations |
| `GET` | `/api/runs` | Recent job runs (log history). Supports filtering query params |
| `GET` | `/api/runs/:runId` | Individual run detail with full logs and associated tasks |
| `GET` | `/api/runs/:runId/tail` | Live log tail (JSON). Supports `?after=<id>` for polling |
| `GET` | `/api/runs/issue` | Issue-specific run history. Requires `?repo=owner/name&number=123` |
| `GET` | `/api/notifications` | Recent notification history |
| `GET` | `/api/learnings` | Pending/consolidated environment learnings |
| `GET` | `/api/config` | Current config `{values, envOverrides}` with sensitive fields masked |
| `GET` | `/api/repos` | Configured repositories with active queue items and recent completed tasks |
| `GET` | `/api/notifications/stream` | Server-Sent Events stream for real-time notifications (see below) |

---

## Control Routes (Auth Required, POST)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/jobs/:name/trigger` | Manually trigger a job. `200` (started), `404` (unknown), or `409` (busy / update pending) |
| `POST` | `/api/jobs/:name/pause` | Toggle pause/resume for a job. Persists to `pausedJobs`. Returns `{result: "paused" \| "resumed"}` |
| `POST` | `/api/tasks/cancel` | Cancel the currently-running AI task (SIGTERM→SIGKILL). Returns `{result: "cancelled" \| "no-active-task"}` |
| `POST` | `/api/update/check` | Request an immediate update check (writes the update-check sentinel). Returns `{result: "requested"}` |
| `POST` | `/api/queue/merge` | Squash-merge a PR. Body: `{"repo": "owner/name", "prNumber": 123}` |
| `POST` | `/api/queue/skip` | Skip an issue/PR. Body: `{"repo": "owner/name", "number": 123}` |
| `POST` | `/api/queue/unskip` | Remove a skip. Body: `{"repo": "owner/name", "number": 123}` |
| `POST` | `/api/queue/prioritize` | Mark item high-priority. Body: `{"repo": "owner/name", "number": 123}` |
| `POST` | `/api/queue/deprioritize` | Remove priority. Body: `{"repo": "owner/name", "number": 123}` |
| `POST` | `/api/repos` | Add a repo to `allowedRepos`. Body: `{"repo": "repo-name"}`. Returns `{result: "added"}` |
| `POST` | `/api/config` | Update whitelisted config fields. Triggers live reload. Returns `{saved: true, tab}` |
| `POST` | `/api/learnings/:id/dismiss` | Dismiss a pending environment learning (idempotent). Optional body `{"reason": "..."}` |

Env-overridden config fields are dropped from `POST /api/config` writes, since the environment value wins at load time.

---

## Response Formats

### Health Check

```json
{
  "status": "ok",
  "version": "v2026-07-01.1",
  "activeTasks": 1,
  "updatePending": false
}
```

`activeTasks` is the deploy drain signal — the updater waits for it to reach `0` before restarting. `updatePending` reflects the quiesce sentinel.

### Session

```json
{
  "authEnabled": true,
  "authenticated": false,
  "username": null,
  "methods": { "token": true, "oauth": false },
  "oauthLoginUrl": "/auth/github"
}
```

### Trigger Job

```json
{ "result": "started" }
```

`200` for `started`; `404` for an unknown job; `409` when the job is already running or an update is pending.

### Cancel Task

```json
{ "result": "cancelled" }
```

Possible values: `"cancelled"`, `"no-active-task"`.

---

## Real-time Notifications

`GET /api/notifications/stream` is a Server-Sent Events stream. It supports the `Last-Event-ID` header to replay events missed while disconnected and sends a keepalive comment periodically. Each event carries a JSON payload:

```json
{
  "id": 42,
  "jobName": "issue-worker",
  "message": "Opened PR #99 for issue #50",
  "url": "https://github.com/org/repo/pull/99",
  "level": "info",
  "createdAt": "2026-07-01T14:30:00.000Z"
}
```

---

## Queue Categories

`GET /api/queue` groups items into two sections:

**Human attention** (waiting for a person):

- `ready` — issues with plans ready for review

**Yeti attention** (Yeti is working on or will work on):

- `needs-refinement` — issues needing plans
- `refined` — issues approved for implementation
- `needs-review-addressing` — PRs with unaddressed review comments
- `auto-mergeable` — PRs ready to auto-merge
- `needs-triage` — error issues needing investigation
- `needs-plan-review` — plans awaiting adversarial review

Items whose next action exceeds their repo's [autonomy tier](configuration.md#autonomy) are annotated with the current tier and the tier the action requires, so the dashboard can show why they are held.
