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
  url: string;
}

export function notify(n: Notification): void {
  // 1. Insert into notifications table
  // 2. Broadcast to SSE clients via EventEmitter
  // 3. Forward to Discord (compose text from structured fields)
}
```

All ~10-12 existing `notify()` call sites across jobs are updated from:
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

Discord output is composed inside `notify()` from the structured fields, maintaining the same format users see today.

### 2. Storage: `notifications` Table

New table in `yeti.db`:

| Column       | Type       | Description                        |
|-------------|------------|------------------------------------|
| `id`        | INTEGER PK | Auto-increment                     |
| `job_name`  | TEXT       | Job that emitted the notification  |
| `message`   | TEXT       | Human-readable description         |
| `url`       | TEXT       | GitHub URL (issue or PR link)      |
| `created_at`| TEXT       | ISO 8601 timestamp                 |

Created alongside existing tables in `db.ts` initialization.

### 3. Event Emission

`notify.ts` gains an in-memory `EventEmitter` that fires on every notification:

- `notify()` inserts the row into SQLite, then emits the event
- `server.ts` subscribes to the emitter to push to SSE clients
- Discord forwarding continues as before

### 4. SSE Endpoint

**Route:** `GET /notifications/stream`

- Protected by `requireAuth()`
- Holds open HTTP connections with `Content-Type: text/event-stream`
- On each notification event, sends `data: <JSON>` to all connected clients
- Standard SSE keepalive via periodic comment lines

### 5. Client-Side Toasts

Added to the dashboard HTML (shared across all pages):

- `EventSource` connects to `/notifications/stream`
- On message, renders a toast popup in the bottom-right corner
- Toast auto-dismisses after ~8 seconds, click to dismiss early
- Clicking the toast body opens the GitHub URL in a new tab
- Simple CSS animation for slide-in/fade-out

### 6. Recent Notifications Page

**Route:** `GET /notifications`

- New page builder in `src/pages/notifications.ts`
- New nav link "Notifications" in the dashboard header
- Displays the last 50 notifications from the DB, newest first
- Table columns: timestamp, job name, message, link
- Protected by `requireAuth()`

### 7. Pruning

- On startup: delete notifications older than 7 days
- While running: `setInterval` every 24 hours performs the same cleanup
- Hardcoded 7-day retention, no config knob

## Affected Files

| File | Change |
|------|--------|
| `src/notify.ts` | New `Notification` type, `EventEmitter`, SQLite insert, restructured `notify()` |
| `src/db.ts` | New `notifications` table creation, insert/query/prune functions |
| `src/server.ts` | New `/notifications/stream` SSE route, `/notifications` page route, subscribe to emitter, pruning interval, nav link |
| `src/pages/notifications.ts` | New file — notifications list page builder |
| `src/pages/dashboard.ts` | Add toast container and `EventSource` JS to shared page layout |
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
| `src/main.ts` | Startup pruning call |

## Testing

- Unit tests for `notify()`: verify SQLite insert, EventEmitter emission, Discord forwarding
- Unit tests for DB functions: insert, query (limit/order), prune by age
- Unit tests for SSE endpoint: connection handling, event delivery
- Unit tests for notification page builder: HTML output
- Existing job tests updated to match new `notify()` signature
