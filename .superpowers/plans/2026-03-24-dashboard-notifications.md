# Dashboard Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real-time SSE toast notifications and a persistent notifications page to the Yeti dashboard.

**Architecture:** Extend `notify()` from a string passthrough to a structured dispatcher that inserts into SQLite, emits via EventEmitter, and forwards to Discord. `server.ts` subscribes to the emitter and pushes to SSE-connected dashboard clients. A new notifications page shows history.

**Tech Stack:** Node.js, TypeScript (strict ESM), better-sqlite3, vitest, native SSE (EventSource)

**Spec:** `.superpowers/specs/2026-03-24-dashboard-notifications-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/db.ts` | Add `notifications` table, insert/query/prune functions |
| `src/notify.ts` | `Notification` type, EventEmitter, structured `notify()` with DB insert + Discord |
| `src/server.ts` | SSE endpoint, `/notifications` page route, `closeSSEConnections()` export |
| `src/pages/notifications.ts` | New — notifications list page builder |
| `src/pages/layout.ts` | Toast container, EventSource JS, CSS, nav link |
| `src/main.ts` | Notification pruning (startup + interval), SSE shutdown |
| `src/log.ts` | Migrate `notify()` call to structured type |
| `src/github.ts` | Migrate `notify()` calls to structured type |
| `src/startup-announce.ts` | Migrate `notify()` call to structured type |
| `src/jobs/*.ts` | Migrate all `notify()` calls to structured type (11 job files, 16 call sites) |

---

### Task 1: DB — notifications table and functions

**Files:**
- Modify: `src/db.ts:7-65` (table creation), append new functions after line 397
- Test: `src/db.test.ts`

- [ ] **Step 1: Write failing tests for notification DB functions**

Add to `src/db.test.ts` — a new `describe("notifications")` block:

```typescript
describe("notifications", () => {
  it("inserts and returns full row", () => {
    const row = insertNotification("issue-worker", "Created PR #5", "https://github.com/org/repo/pull/5", "info");
    expect(row).toMatchObject({
      job_name: "issue-worker",
      message: "Created PR #5",
      url: "https://github.com/org/repo/pull/5",
      level: "info",
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.created_at).toBeTruthy();
  });

  it("defaults level to info", () => {
    const row = insertNotification("system", "Started");
    expect(row.level).toBe("info");
  });

  it("allows null url", () => {
    const row = insertNotification("system", "Rate limit hit");
    expect(row.url).toBeNull();
  });

  it("getRecentNotifications returns newest first", () => {
    insertNotification("a", "first");
    insertNotification("b", "second");
    insertNotification("c", "third");
    const rows = getRecentNotifications(2);
    expect(rows).toHaveLength(2);
    expect(rows[0].job_name).toBe("c");
    expect(rows[1].job_name).toBe("b");
  });

  it("getNotificationsSince returns after given id, oldest first", () => {
    const r1 = insertNotification("a", "first");
    const r2 = insertNotification("b", "second");
    const r3 = insertNotification("c", "third");
    const rows = getNotificationsSince(r1.id);
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(r2.id);
    expect(rows[1].id).toBe(r3.id);
  });

  it("pruneOldNotifications removes old entries", () => {
    insertNotification("a", "old");
    // Backdate the entry
    _rawDb().prepare("UPDATE notifications SET created_at = datetime('now', '-10 days') WHERE job_name = 'a'").run();
    insertNotification("b", "recent");
    const pruned = pruneOldNotifications(7);
    expect(pruned).toBe(1);
    expect(getRecentNotifications()).toHaveLength(1);
  });
});
```

Import the new functions at the top of the test file alongside existing imports.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/db.test.ts`
Expected: FAIL — `insertNotification` is not exported

- [ ] **Step 3: Add notifications table to initDb()**

In `src/db.ts`, add after the `job_logs` table creation (after line 62):

```typescript
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      job_name   TEXT NOT NULL,
      message    TEXT NOT NULL,
      url        TEXT,
      level      TEXT NOT NULL DEFAULT 'info',
      created_at TEXT NOT NULL
    )
  `);
```

- [ ] **Step 4: Add NotificationRow interface and DB functions**

Add after `pruneOldLogs` (after line 397 in `src/db.ts`):

```typescript
// ── Notifications ──

export interface NotificationRow {
  id: number;
  job_name: string;
  message: string;
  url: string | null;
  level: string;
  created_at: string;
}

export function insertNotification(
  jobName: string,
  message: string,
  url?: string,
  level: string = "info",
): NotificationRow {
  const d = getDb();
  const result = d.prepare(
    `INSERT INTO notifications (job_name, message, url, level, created_at) VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(jobName, message, url ?? null, level);
  return d.prepare(`SELECT * FROM notifications WHERE id = ?`).get(Number(result.lastInsertRowid)) as NotificationRow;
}

export function getRecentNotifications(limit = 50): NotificationRow[] {
  return getDb()
    .prepare(`SELECT * FROM notifications ORDER BY id DESC LIMIT ?`)
    .all(limit) as NotificationRow[];
}

export function getNotificationsSince(afterId: number): NotificationRow[] {
  return getDb()
    .prepare(`SELECT * FROM notifications WHERE id > ? ORDER BY id ASC`)
    .all(afterId) as NotificationRow[];
}

export function pruneOldNotifications(days = 7): number {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const result = getDb()
    .prepare(`DELETE FROM notifications WHERE created_at < ?`)
    .run(cutoff);
  return result.changes;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/db.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Run full test suite to check for regressions**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat: add notifications table and DB functions"
```

---

### Task 2: notify.ts — structured type, EventEmitter, DB insert

**Files:**
- Modify: `src/notify.ts` (full rewrite — 5 lines → ~40 lines)
- Test: `src/notify.test.ts`

- [ ] **Step 1: Write failing tests for structured notify()**

Rewrite `src/notify.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./discord.js", () => ({
  notify: vi.fn(),
}));

vi.mock("./db.js", () => ({
  insertNotification: vi.fn().mockReturnValue({
    id: 1,
    job_name: "test-job",
    message: "test",
    url: null,
    level: "info",
    created_at: "2026-01-01 00:00:00",
  }),
}));

import { notify, notificationEmitter } from "./notify.js";
import { notify as discordNotify } from "./discord.js";
import { insertNotification } from "./db.js";

describe("notify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts into DB and forwards to discord", () => {
    notify({ jobName: "issue-worker", message: "Created PR #5", url: "https://github.com/org/repo/pull/5" });
    expect(insertNotification).toHaveBeenCalledWith("issue-worker", "Created PR #5", "https://github.com/org/repo/pull/5", "info");
    expect(discordNotify).toHaveBeenCalledWith("[issue-worker] Created PR #5\nhttps://github.com/org/repo/pull/5");
  });

  it("omits url line from discord when url is undefined", () => {
    notify({ jobName: "system", message: "Rate limit hit" });
    expect(discordNotify).toHaveBeenCalledWith("[system] Rate limit hit");
  });

  it("defaults level to info", () => {
    notify({ jobName: "system", message: "test" });
    expect(insertNotification).toHaveBeenCalledWith("system", "test", undefined, "info");
  });

  it("passes explicit level", () => {
    notify({ jobName: "system", message: "error!", level: "error" });
    expect(insertNotification).toHaveBeenCalledWith("system", "error!", undefined, "error");
  });

  it("emits notification event", () => {
    const handler = vi.fn();
    notificationEmitter.on("notification", handler);
    notify({ jobName: "test", message: "hello" });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ job_name: "test-job" }));
    notificationEmitter.off("notification", handler);
  });

  it("still forwards to discord if DB insert throws", () => {
    vi.mocked(insertNotification).mockImplementationOnce(() => { throw new Error("DB fail"); });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    notify({ jobName: "test", message: "hello" });
    expect(discordNotify).toHaveBeenCalledWith("[test] hello");
    stderrSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/notify.test.ts`
Expected: FAIL — `notificationEmitter` not exported, `notify` still takes string

- [ ] **Step 3: Implement structured notify()**

Rewrite `src/notify.ts`:

```typescript
import { EventEmitter } from "node:events";
import { notify as discordNotify } from "./discord.js";
import { insertNotification, type NotificationRow } from "./db.js";

export type NotificationLevel = "info" | "warn" | "error";

export interface Notification {
  jobName: string;
  message: string;
  url?: string;
  level?: NotificationLevel;
}

export const notificationEmitter = new EventEmitter();

export function notify(n: Notification): void {
  const level = n.level ?? "info";

  // 1. Insert into DB (error-safe — stderr only, no log.error to avoid recursion)
  let row: NotificationRow | undefined;
  try {
    row = insertNotification(n.jobName, n.message, n.url, level);
  } catch (err) {
    process.stderr.write(`[notify] DB insert failed: ${err}\n`);
  }

  // 2. Broadcast to SSE clients
  if (row) {
    notificationEmitter.emit("notification", row);
  }

  // 3. Forward to Discord
  const text = n.url
    ? `[${n.jobName}] ${n.message}\n${n.url}`
    : `[${n.jobName}] ${n.message}`;
  discordNotify(text);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/notify.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/notify.ts src/notify.test.ts
git commit -m "feat: structured Notification type with DB insert and EventEmitter"
```

---

### Task 3: Migrate all notify() callers to structured type

**Files:**
- Modify: `src/log.ts`, `src/github.ts`, `src/startup-announce.ts`, and 11 job files
- No new tests — existing tests cover these call sites

This is a mechanical migration. Every `notify(string)` call becomes `notify({ jobName, message, url?, level? })`.

- [ ] **Step 1: Migrate non-job callers**

**`src/log.ts`** — find the `notify()` call (line 54, inside `error()` function):
```typescript
// Before:
notify(`[ERROR] ${msg}`);
// After:
notify({ jobName: "system", message: msg, level: "error" });
```

**`src/github.ts`** — two calls:
```typescript
// Line 29 — rate limit hit:
// Before:
notify(`[WARN] GitHub API rate limit hit — blocking calls for ${cooldownMs / 1000}s`);
// After:
notify({ jobName: "system", message: `GitHub API rate limit hit — blocking calls for ${cooldownMs / 1000}s`, level: "warn" });

// Line 341 — rate limit passed:
// Before:
notify("[INFO] GitHub API rate limit passed — resuming operations");
// After:
notify({ jobName: "system", message: "GitHub API rate limit passed — resuming operations" });
```

**`src/startup-announce.ts`** — line 19:
```typescript
// Before:
notify(`Yeti started with updated version ${version}`);
// After:
notify({ jobName: "system", message: `Yeti started with updated version ${version}` });
```

Update imports in all three files: the import `{ notify } from "./notify.js"` stays the same (same function name, different signature).

- [ ] **Step 2: Migrate job callers**

For each job file, change `notify(string)` to `notify({ jobName, message, url })`. The pattern is consistent — extract the `[job-name]` prefix into `jobName`, the description into `message`, and the URL (after `\n`) into `url`.

**`src/jobs/plan-reviewer.ts`** (1 call, line 115):
```typescript
notify({ jobName: "plan-reviewer", message: `Review posted for ${fullName}#${issue.number}`, url: gh.issueUrl(fullName, issue.number) });
```

**`src/jobs/auto-merger.ts`** (1 call, line 74):
```typescript
notify({ jobName: "auto-merger", message: `Merged ${repo.fullName}#${pr.number}`, url: gh.pullUrl(repo.fullName, pr.number) });
```

**`src/jobs/prompt-evaluator.ts`** (1 call, line 454):
```typescript
notify({ jobName: "prompt-evaluator", message: `Improvement found for ${entry.name} — issue #${issueNumber}`, url: gh.issueUrl(SELF_REPO, issueNumber) });
```

**`src/jobs/issue-refiner.ts`** (3 calls, lines 215, 273, 294):
```typescript
// Lines 215 and 273 (plan produced):
notify({ jobName: "issue-refiner", message: `Plan produced for ${fullName}#${issue.number}`, url: gh.issueUrl(fullName, issue.number) });

// Line 294 (plan updated):
notify({ jobName: "issue-refiner", message: `Plan updated for ${fullName}#${issue.number}`, url: gh.issueUrl(fullName, issue.number) });
```

**`src/jobs/review-addresser.ts`** (1 call, line 52):
```typescript
notify({ jobName: "review-addresser", message: `Addressed review on ${fullName}#${pr.number}`, url: gh.pullUrl(fullName, pr.number) });
```

**`src/jobs/mkdocs-update.ts`** (1 call, line 86):
```typescript
notify({ jobName: "mkdocs-update", message: `Created PR #${prNumber} for ${fullName}`, url: gh.pullUrl(fullName, prNumber) });
```

**`src/jobs/issue-worker.ts`** (1 call, line 210):
```typescript
notify({ jobName: "issue-worker", message: `Created PR #${prNumber} for ${fullName}#${issue.number}`, url: gh.pullUrl(fullName, prNumber) });
```

**`src/jobs/improvement-identifier.ts`** (1 call, line 203):
```typescript
notify({ jobName: "improvement-identifier", message: `Created PR #${prNumber} for ${fullName}`, url: gh.pullUrl(fullName, prNumber) });
```

**`src/jobs/issue-auditor.ts`** (1 call, line 154):
```typescript
// Before:
notify(summary);
// After (summary is like "Issue auditor: fixed N issue(s) — ..."):
notify({ jobName: "issue-auditor", message: summary });
```

**`src/jobs/doc-maintainer.ts`** (1 call, line 153):
```typescript
notify({ jobName: "doc-maintainer", message: `Created PR #${prNumber} for ${fullName}`, url: gh.pullUrl(fullName, prNumber) });
```

**`src/jobs/ci-fixer.ts`** (4 calls, lines 38, 76, 273, 309):
```typescript
// Lines 38, 76 (merge conflict resolved):
notify({ jobName: "ci-fixer", message: `Resolved merge conflict for ${fullName}#${pr.number}`, url: gh.pullUrl(fullName, pr.number) });

// Line 273 (pushed fix):
notify({ jobName: "ci-fixer", message: `Pushed fix for ${fullName}#${pr.number}`, url: gh.pullUrl(fullName, pr.number) });

// Line 309 (ci-unrelated issue):
notify({ jobName: "ci-fixer", message: `Created ci-unrelated issue ${repoName}#${issueNumber}`, url: gh.issueUrl(repoName, issueNumber) });
```

- [ ] **Step 3: Update mocked notify() in job test files**

Search all test files for mocked `notify` calls:

Run: `grep -rn 'toHaveBeenCalledWith.*notify\|notify.*toHaveBeenCalledWith\|mockNotify.*toHaveBeenCalledWith\|toHaveBeenCalledWith.*mockNotify' src/jobs/`

The mock declaration (`vi.mock("../notify.js", ...)` returning `{ notify: vi.fn() }`) stays the same. But assertions using `expect.stringContaining()` must change to `expect.objectContaining()`:

```typescript
// Before:
expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("[ci-fixer] Pushed fix"));
// After:
expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
  jobName: "ci-fixer",
  message: expect.stringContaining("Pushed fix"),
}));

// Before:
expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("Created PR"));
// After:
expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
  message: expect.stringContaining("Created PR"),
}));
```

Apply this pattern to all matching assertions across job test files.

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: ALL PASS — typecheck passes (no string args to notify), all job tests pass

- [ ] **Step 5: Commit**

```bash
git add src/log.ts src/github.ts src/startup-announce.ts src/jobs/
git commit -m "refactor: migrate all notify() callers to structured Notification type"
```

---

### Task 4: SSE endpoint and connection management in server.ts

**Files:**
- Modify: `src/server.ts` (add route + connection tracking + closeSSEConnections export)
- Test: `src/server.test.ts`

- [ ] **Step 1: Add notification DB mock to server.test.ts**

In `src/server.test.ts`, add to the existing `vi.mock("./db.js", ...)` block (inside the mock object, after line 134):

```typescript
  getRecentNotifications: vi.fn().mockReturnValue([]),
  getNotificationsSince: vi.fn().mockReturnValue([]),
```

Add a mock for notify.js (must be before imports, alongside other `vi.mock` calls):

```typescript
import { EventEmitter } from "node:events";

vi.mock("./notify.js", () => ({
  notificationEmitter: new EventEmitter(),
}));
```

- [ ] **Step 2: Write failing tests for SSE endpoint and notifications page**

Add to `src/server.test.ts`. Note: the existing `request()` helper has the signature `request(server, method, path, options?)` and returns `{ status, headers, body }`. The SSE endpoint never closes, so it cannot use the standard helper — use a raw `http.request` with `AbortController` instead:

```typescript
describe("SSE notifications", () => {
  it("GET /notifications/stream returns event-stream headers", async () => {
    const addr = server.address() as { port: number };
    const { status, headers } = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request(
        { hostname: "127.0.0.1", port: addr.port, path: "/notifications/stream", method: "GET", headers: { cookie: `yeti_token=test-token` } },
        (res) => {
          resolve({ status: res.statusCode!, headers: res.headers });
          res.destroy(); // Close immediately after reading headers
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(200);
    expect(headers["content-type"]).toBe("text/event-stream");
    expect(headers["cache-control"]).toBe("no-cache");
    expect(headers["x-accel-buffering"]).toBe("no");
  });

  it("GET /notifications/stream requires auth", async () => {
    const res = await request(server, "GET", "/notifications/stream");
    expect(res.status).toBe(302);
  });
});

describe("notifications page", () => {
  it("GET /notifications returns HTML", async () => {
    const res = await request(server, "GET", "/notifications", {
      headers: { cookie: `yeti_token=test-token` },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain("Notifications");
  });

  it("GET /notifications requires auth", async () => {
    const res = await request(server, "GET", "/notifications");
    expect(res.status).toBe(302);
  });
});
```

Note: use the same auth token value that the existing tests use (check the `AUTH_TOKEN` mock value in the config mock at the top of the file).

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/server.test.ts`
Expected: FAIL — routes not implemented

- [ ] **Step 4: Add SSE endpoint to server.ts**

Add imports at top of `src/server.ts`:

```typescript
import { notificationEmitter } from "./notify.js";
import { getRecentNotifications, getNotificationsSince } from "./db.js";
import { buildNotificationsPage } from "./pages/notifications.js";
```

Add module-level SSE state:

```typescript
const sseClients = new Set<{ res: http.ServerResponse; keepalive: ReturnType<typeof setInterval> }>();
```

Subscribe to emitter (inside `createServer`, after creating the server):

```typescript
notificationEmitter.on("notification", (row) => {
  const payload = JSON.stringify({
    id: row.id,
    jobName: row.job_name,
    message: row.message,
    url: row.url,
    level: row.level,
    createdAt: row.created_at,
  });
  for (const client of sseClients) {
    client.res.write(`id: ${row.id}\ndata: ${payload}\n\n`);
  }
});
```

Add `GET /notifications/stream` route in `handleRequest()` (in the GET routes section):

```typescript
if (req.url === "/notifications/stream") {
  if (!requireAuth(req, res)) return;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  // Replay missed notifications if Last-Event-ID is present
  const lastId = req.headers["last-event-id"];
  if (lastId) {
    const missed = getNotificationsSince(Number(lastId));
    for (const row of missed) {
      const payload = JSON.stringify({
        id: row.id, jobName: row.job_name, message: row.message,
        url: row.url, level: row.level, createdAt: row.created_at,
      });
      res.write(`id: ${row.id}\ndata: ${payload}\n\n`);
    }
  }

  const keepalive = setInterval(() => {
    res.write(`: keepalive\n\n`);
  }, 30_000);
  const client = { res, keepalive };
  sseClients.add(client);

  req.on("close", () => {
    clearInterval(keepalive);
    sseClients.delete(client);
  });
  return;
}
```

Add `GET /notifications` route:

```typescript
if (req.url === "/notifications") {
  const auth = requireAuth(req, res);
  if (!auth) return;
  const notifications = getRecentNotifications(50);
  const html = buildNotificationsPage(notifications, theme, auth.username);
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(html);
  return;
}
```

Export `closeSSEConnections`:

```typescript
export function closeSSEConnections(): void {
  for (const client of sseClients) {
    clearInterval(client.keepalive);
    client.res.end();
  }
  sseClients.clear();
}
```

- [ ] **Step 5: Create stub notifications page builder**

Create `src/pages/notifications.ts` with a minimal stub (will be fully implemented in Task 5):

```typescript
import type { NotificationRow } from "../db.js";
import { PAGE_CSS, buildNav, htmlOpenTag, siteTitle, THEME_SCRIPT, escapeHtml, formatRelativeTime } from "./layout.js";

export type Theme = "system" | "light" | "dark";

export function buildNotificationsPage(
  notifications: NotificationRow[],
  theme: Theme,
  username?: string | null,
): string {
  return `<!DOCTYPE html>${htmlOpenTag(theme)}<head><title>${siteTitle("Notifications")}</title><style>${PAGE_CSS}</style></head><body><h1>yeti</h1>${buildNav(theme, username)}<h2>Notifications</h2><p>Coming soon</p>${THEME_SCRIPT}</body></html>`;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/server.test.ts`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/server.ts src/server.test.ts src/pages/notifications.ts
git commit -m "feat: add SSE endpoint and notifications route"
```

---

### Task 5: Notifications page builder

**Files:**
- Modify: `src/pages/notifications.ts` (replace stub)
- Create: `src/pages/notifications.test.ts`

- [ ] **Step 1: Write failing tests for notifications page**

Create `src/pages/notifications.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildNotificationsPage } from "./notifications.js";

describe("buildNotificationsPage", () => {
  it("renders empty state", () => {
    const html = buildNotificationsPage([], "system");
    expect(html).toContain("No notifications");
  });

  it("renders notification rows", () => {
    const notifications = [
      { id: 2, job_name: "issue-worker", message: "Created PR #5", url: "https://github.com/org/repo/pull/5", level: "info", created_at: "2026-03-24 14:30:00" },
      { id: 1, job_name: "system", message: "Rate limit hit", url: null, level: "warn", created_at: "2026-03-24 14:00:00" },
    ];
    const html = buildNotificationsPage(notifications, "light");
    expect(html).toContain("issue-worker");
    expect(html).toContain("Created PR #5");
    expect(html).toContain("https://github.com/org/repo/pull/5");
    expect(html).toContain("Rate limit hit");
    expect(html).toContain("Notifications");
  });

  it("includes level as CSS class for styling", () => {
    const notifications = [
      { id: 1, job_name: "system", message: "Error!", url: null, level: "error", created_at: "2026-03-24 14:00:00" },
    ];
    const html = buildNotificationsPage(notifications, "system");
    expect(html).toContain("level-error");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/pages/notifications.test.ts`
Expected: FAIL — empty state not rendered, rows not rendered

- [ ] **Step 3: Implement full notifications page builder**

Replace `src/pages/notifications.ts`:

```typescript
import type { NotificationRow } from "../db.js";
import { PAGE_CSS, buildNav, htmlOpenTag, siteTitle, THEME_SCRIPT, escapeHtml, formatRelativeTime } from "./layout.js";

export type Theme = "system" | "light" | "dark";

export function buildNotificationsPage(
  notifications: NotificationRow[],
  theme: Theme,
  username?: string | null,
): string {
  let body: string;
  if (notifications.length === 0) {
    body = `<p class="empty">No notifications yet.</p>`;
  } else {
    const rows = notifications.map(n => {
      const link = n.url
        ? `<a href="${escapeHtml(n.url)}" target="_blank">${escapeHtml(n.message)}</a>`
        : escapeHtml(n.message);
      return `<tr class="level-${n.level}">
        <td>${formatRelativeTime(n.created_at)}</td>
        <td>${escapeHtml(n.job_name)}</td>
        <td>${link}</td>
        <td>${n.level}</td>
      </tr>`;
    }).join("");
    body = `<table><thead><tr><th>Time</th><th>Job</th><th>Message</th><th>Level</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head><title>${siteTitle("Notifications")}</title><style>${PAGE_CSS}</style></head>
<body>
<h1>yeti</h1>
${buildNav(theme, username)}
<h2>Notifications</h2>
${body}
${THEME_SCRIPT}
</body></html>`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/pages/notifications.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/pages/notifications.ts src/pages/notifications.test.ts
git commit -m "feat: add notifications page builder"
```

---

### Task 6: Toast UI and EventSource in layout.ts

**Files:**
- Modify: `src/pages/layout.ts:491-501` (buildNav), add toast CSS + JS

- [ ] **Step 1: Add "Notifications" link to nav**

In `src/pages/layout.ts`, `buildNav()` (line 500), insert the Notifications link between Logs and Config:

```typescript
// Before:
...`<a href="/logs">Logs</a><a href="/config">Config</a>`...
// After:
...`<a href="/logs">Logs</a><a href="/notifications">Notifications</a><a href="/config">Config</a>`...
```

- [ ] **Step 2: Add toast CSS to PAGE_CSS**

Append to `PAGE_CSS` in `src/pages/layout.ts` (before the closing backtick):

```css
/* Toast notifications */
#toast-container{position:fixed;bottom:1rem;right:1rem;z-index:1000;display:flex;flex-direction:column-reverse;gap:0.5rem;max-width:400px}
.toast{background:var(--bg-secondary);border:1px solid var(--border);border-left:4px solid var(--accent);border-radius:6px;padding:0.75rem 1rem;box-shadow:0 4px 12px rgba(0,0,0,0.15);cursor:pointer;animation:toast-in 0.3s ease-out;transition:opacity 0.3s}
.toast.level-warn{border-left-color:#f59e0b}
.toast.level-error{border-left-color:#ef4444}
.toast .toast-job{font-size:0.75rem;color:var(--text-secondary);margin-bottom:0.25rem}
.toast .toast-msg{font-size:0.875rem;color:var(--text)}
.toast.dismissing{opacity:0}
@keyframes toast-in{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}
```

- [ ] **Step 3: Add toast container and EventSource script**

Add a new `TOAST_SCRIPT` export to `src/pages/layout.ts`. This is separate from `THEME_SCRIPT` because the login page also uses `THEME_SCRIPT` — if the EventSource were on the login page, it would hit the auth-protected SSE endpoint and get 401s in a reconnect loop.

```typescript
export const TOAST_SCRIPT = `<div id="toast-container"></div><script>
(function(){
  if(!window.EventSource)return;
  var es=new EventSource("/notifications/stream");
  es.onmessage=function(e){
    try{var d=JSON.parse(e.data);showToast(d)}catch(err){}
  };
  function showToast(n){
    var c=document.getElementById("toast-container");
    var t=document.createElement("div");
    t.className="toast"+(n.level&&n.level!=="info"?" level-"+n.level:"");
    t.innerHTML='<div class="toast-job">'+esc(n.jobName)+'</div><div class="toast-msg">'+esc(n.message)+'</div>';
    if(n.url){t.onclick=function(){window.open(n.url,"_blank")}}
    t.addEventListener("click",function(){dismiss(t)});
    c.appendChild(t);
    setTimeout(function(){dismiss(t)},8000);
  }
  function dismiss(t){t.classList.add("dismissing");setTimeout(function(){t.remove()},300)}
  function esc(s){var d=document.createElement("div");d.textContent=s;return d.innerHTML}
})();
</script>`;
```

Then append `${TOAST_SCRIPT}` after `${THEME_SCRIPT}` in each authenticated page builder. There are ~7 page builders to update (dashboard, queue, logs, config, jobs, repos, notifications). Each one already ends with `${THEME_SCRIPT}</body></html>` — change to `${THEME_SCRIPT}${TOAST_SCRIPT}</body></html>`. The login page does NOT include `TOAST_SCRIPT`.

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: ALL PASS — nav tests in server.test.ts may check for nav links; verify "Notifications" appears

- [ ] **Step 5: Commit**

```bash
git add src/pages/layout.ts
git commit -m "feat: add toast notifications UI and nav link to layout"
```

---

### Task 7: Pruning and shutdown in main.ts

**Files:**
- Modify: `src/main.ts:88-100` (pruning section), `src/main.ts:366-391` (shutdown)

- [ ] **Step 1: Add notification pruning at startup**

In `src/main.ts`, add import:

```typescript
import { pruneOldNotifications } from "./db.js";
import { closeSSEConnections } from "./server.js";
```

After the existing log pruning block (after line 100), add:

```typescript
// ── Notification pruning ──

try {
  const notifPruned = pruneOldNotifications(7);
  if (notifPruned > 0) {
    log.info(`Pruned ${notifPruned} old notification(s)`);
  }
} catch {
  // best effort
}
```

- [ ] **Step 2: Add notification pruning to the 24h interval**

In the existing `pruneInterval` callback (line 93-100), add inside the try block:

```typescript
  const np = pruneOldNotifications(7);
  if (np > 0) log.info(`Pruned ${np} old notification(s)`);
```

- [ ] **Step 3: Add SSE cleanup to shutdown()**

In `shutdown()` (line 366-391), add `closeSSEConnections()` before `server.close()` (before line 386):

```typescript
  closeSSEConnections();
  server.close();
```

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat: add notification pruning and SSE shutdown cleanup"
```

---

### Task 8: Final verification and documentation

**Files:**
- Modify: `yeti/OVERVIEW.md`, `CLAUDE.md` (if needed)

- [ ] **Step 1: Run full test suite and typecheck**

Run: `npm test`
Expected: ALL PASS (typecheck + vitest)

- [ ] **Step 2: Run dev server smoke test**

Run: `npm run dev` and verify:
- Dashboard loads at `http://localhost:9384/`
- Notifications page loads at `http://localhost:9384/notifications`
- SSE stream connects at `http://localhost:9384/notifications/stream`
- Nav shows "Notifications" link between "Logs" and "Config"

Stop the dev server.

- [ ] **Step 3: Update documentation**

Update `yeti/OVERVIEW.md` to mention:
- The `notifications` table in the database section
- The `notificationEmitter` in the `notify.ts` module description
- The SSE endpoint and notifications page in the `server.ts` module description
- The toast UI in the layout section

Update `CLAUDE.md` if any cross-cutting concerns changed (e.g., new config fields — none in this case).

- [ ] **Step 4: Commit documentation**

```bash
git add yeti/OVERVIEW.md CLAUDE.md
git commit -m "docs: update documentation for dashboard notifications"
```
