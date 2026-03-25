# Dashboard Notifications — Design Spec

**Date:** 2026-03-24
**Status:** Draft

## Overview

Add real-time notifications to the Yeti dashboard so the user is alerted when key workflow events happen — plans posted, reviews posted, PRs created, merges, etc. Notifications are delivered via Server-Sent Events (SSE) as toast popups, with a "Recent Notifications" page for catch-up.

## Goals

- Real-time toast notifications in the dashboard when jobs complete meaningful actions
- Persistent notification history (survives restarts) via SQLite
- No changes to job logic — hook into the existing `notify()` dispatch point

## Non-Goals

- Browser Push Notifications (Web Push API / service workers)
- Notification preferences or filtering
- Email or Slack notifications (Discord already exists)

## Design

### 1. Structured Notification Type

Replace the current string-based `notify()` signature with a structured type:

```typescript
export interface Notification {
  jobName: string;
  message: string;
  url?: string;  // optional — system notifications (rate limits, startup) have no URL
}

export function notify(n: Notification): void {
  // 1. Insert into notifications table (try/catch to prevent recursive loops — see §3)
  // 2. Broadcast to SSE clients via EventEmitter
  // 3. Forward to Discord (compose text from structured fields)
}
```

**Job call sites (~10-12)** are updated from:
```typescript
notify(`[issue-worker] Created PR #${prNumber} for ${fullName}#${issue.number}\n${gh.pullUrl(fullName, prNumber)}`);
```
to:
```typescript
notify({
  jobName: "issue-worker",
  message: `Created PR #${prNumber} for ${fullName}#${issue.number}`,
  url: gh.pullUrl(fullName, prNumber),
});
```

**Non-job callers** also migrate to the structured type:

- `src/log.ts` — error-level forwarding: `{ jobName: "system", message: "..." }`
- `src/github.ts` — rate-limit notifications: `{ jobName: "system", message: "..." }`
- `src/startup-announce.ts` — startup notice: `{ jobName: "system", message: "..." }`
- `src/jobs/issue-auditor.ts` — summary without URL: `{ jobName: "issue-auditor", message: "..." }`

**Discord output** is composed inside `notify()` as:

```text
[${n.jobName}] ${n.message}
${n.url}        // omitted when url is undefined
```

### 2. Storage: `notifications` Table

New table in `yeti.db`:

| Column | Type | Description |
| --- | --- | --- |
| `id` | INTEGER PK | Auto-increment |
| `job_name` | TEXT | Job that emitted the notification |
| `message` | TEXT | Human-readable description |
| `url` | TEXT | GitHub URL (nullable) |
| `created_at` | TEXT | Timestamp via `datetime('now')` (matches existing tables) |

Created alongside existing tables in `db.ts` initialization.

DB functions to add:

- `insertNotification(jobName, message, url?)` — returns the full inserted row (id, job_name, message, url, created_at) so the emitter has the complete payload for SSE broadcast
- `getRecentNotifications(limit = 50)` — newest first
- `getNotificationsSince(afterId: number)` — returns notifications with `id > afterId`, oldest first (for SSE replay on reconnect)
- `pruneOldNotifications(days = 7)` — delete older than N days

### 3. Event Emission

`notify.ts` gains an in-memory `EventEmitter` that fires on every notification:

- `notify()` inserts the row into SQLite, then emits the event with the full row (including `id` and `created_at`)
- `server.ts` subscribes to the emitter to push to SSE clients
- Discord forwarding continues as before

**Error handling:** The DB insert is wrapped in try/catch. If it fails, log the error directly to stderr (not via `log.error()`, which itself calls `notify()`) and continue with Discord delivery. This prevents recursive loops.

### 4. SSE Endpoint

**Route:** `GET /notifications/stream`

- Protected by `requireAuth()` — works via cookies (`yeti_token` / `yeti_session`). Note: the browser `EventSource` API does not support custom headers, so cookie-based auth is required. This is already supported by the existing auth middleware.
- Response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no` (for nginx reverse proxy compatibility)
- Active connections tracked in a `Set<ServerResponse>`; listener removed and response ended on client `close` event
- On each notification event, sends to all connected clients:

  ```text
  id: <notification.id>
  data: <JSON payload>
  ```

- SSE `id` field enables `Last-Event-ID` on reconnect — on new connection, if `Last-Event-ID` header is present, query `getNotificationsSince(id)` and stream the backlog before subscribing to live events
- Keepalive: send `: keepalive\n\n` comment every 30 seconds via per-client `setInterval`; clear the interval in the `close` event handler and during shutdown
- On graceful shutdown (SIGINT/SIGTERM): clear all keepalive intervals and close all active SSE connections
- Set `emitter.setMaxListeners()` appropriately to avoid Node warnings

**SSE JSON payload shape:**
```json
{
  "id": 42,
  "jobName": "issue-refiner",
  "message": "Plan produced for org/repo#15",
  "url": "https://github.com/org/repo/issues/15",
  "createdAt": "2026-03-24 14:30:00"
}
```

### 5. Client-Side Toasts

Added to the shared page layout in `src/pages/layout.ts` (so toasts work on all dashboard pages):

- `EventSource` connects to `/notifications/stream`
- On message, renders a toast popup in the bottom-right corner
- Toast auto-dismisses after ~8 seconds, click to dismiss early
- Clicking the toast body opens the GitHub URL in a new tab (when URL is present)
- Simple CSS animation for slide-in/fade-out
- Toasts stack vertically if multiple arrive in quick succession

### 6. Recent Notifications Page

**Route:** `GET /notifications`

- New page builder in `src/pages/notifications.ts`
- New nav link "Notifications" in the dashboard header (in `layout.ts`), placed between "Logs" and "Config" in the nav order
- Displays the last 50 notifications from the DB, newest first
- Table columns: timestamp, job name, message, link
- Protected by `requireAuth()`

### 7. Pruning

- On startup in `main.ts`: delete notifications older than 7 days (alongside existing `pruneOldLogs` call)
- While running: `setInterval` every 24 hours in `main.ts` performs the same cleanup (alongside existing log pruning interval)
- Hardcoded 7-day retention, no config knob

## Affected Files

| File | Change |
|------|--------|
| `src/notify.ts` | New `Notification` type, `EventEmitter`, SQLite insert, restructured `notify()`, error-safe DB write |
| `src/db.ts` | New `notifications` table creation, `insertNotification()`, `getRecentNotifications()`, `pruneOldNotifications()` |
| `src/server.ts` | New `/notifications/stream` SSE route, `/notifications` page route, subscribe to emitter, SSE connection tracking and cleanup on shutdown |
| `src/pages/layout.ts` | Toast container HTML/CSS/JS, `EventSource` client code, "Notifications" nav link |
| `src/pages/notifications.ts` | New file — notifications list page builder |
| `src/main.ts` | Startup pruning call, 24h pruning interval (alongside existing log pruning) |
| `src/log.ts` | Update `notify()` call to structured type (`jobName: "system"`) |
| `src/github.ts` | Update `notify()` calls to structured type (`jobName: "system"`) |
| `src/startup-announce.ts` | Update `notify()` call to structured type (`jobName: "system"`) |
| `src/jobs/issue-refiner.ts` | Update `notify()` calls to structured type |
| `src/jobs/plan-reviewer.ts` | Update `notify()` calls to structured type |
| `src/jobs/issue-worker.ts` | Update `notify()` calls to structured type |
| `src/jobs/ci-fixer.ts` | Update `notify()` calls to structured type |
| `src/jobs/doc-maintainer.ts` | Update `notify()` calls to structured type |
| `src/jobs/mkdocs-update.ts` | Update `notify()` calls to structured type |
| `src/jobs/improvement-identifier.ts` | Update `notify()` calls to structured type |
| `src/jobs/auto-merger.ts` | Update `notify()` calls to structured type |
| `src/jobs/review-addresser.ts` | Update `notify()` calls to structured type |
| `src/jobs/prompt-evaluator.ts` | Update `notify()` calls to structured type |
| `src/jobs/issue-auditor.ts` | Update `notify()` call to structured type (no URL) |

## Testing

- Unit tests for `notify()`: verify SQLite insert, EventEmitter emission, Discord forwarding, error-safe DB write (no recursive loop)
- Unit tests for DB functions: insert, query (limit/order), prune by age
- Unit tests for SSE endpoint: connection handling, event delivery, cleanup on disconnect
- Unit tests for notification page builder: HTML output
- Existing job tests updated to match new `notify()` signature
