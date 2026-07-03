import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { EventEmitter } from "node:events";

vi.mock("./config.js", () => ({
  WORK_DIR: "/tmp/yeti",
  SERVER_PORT: 0,
  AUTH_TOKEN: "",
  WEBHOOK_SECRET: "",
  GITHUB_OWNERS: ["owner1"],
  GITHUB_APP_CLIENT_ID: "",
  GITHUB_APP_CLIENT_SECRET: "",
  EXTERNAL_URL: "",
  LABELS: {
    refined: "Refined",
    ready: "Ready",
  },
  LABEL_SPECS: {
    "Refined":              { color: "0075ca", description: "Issue is ready for yeti to implement" },
    "Ready":                { color: "0e8a16", description: "Yeti has finished — needs human attention" },
  },
  LOG_LEVELS: ["debug", "info", "warn", "error"],
  getConfigForDisplay: vi.fn().mockReturnValue({
    githubOwners: ["owner1"],
    selfRepo: "owner1/repo1",
    authToken: "Not configured",
    port: 9384,
    intervals: { issueWorkerMs: 300000, issueRefinerMs: 300000, ciFixerMs: 600000, reviewAddresserMs: 300000, bugInvestigatorMs: 600000, autoMergerMs: 600000 },
    schedules: { docMaintainerHour: 1, repoStandardsHour: 2, improvementIdentifierHour: 3 },
    logLevel: "debug",
    logRetentionDays: 14,
    logRetentionPerJob: 20,
    enabledJobs: ["issue-worker", "ci-fixer"],
    allowedRepos: ["repo1", "repo2"],
  }),
  getEnvOverrides: vi.fn().mockReturnValue({}),
  writeConfig: vi.fn(),
  repoAutonomy: () => "advisory",
  AUTONOMY_MAP: {},
  DEFAULT_AUTONOMY: "advisory",
  SKIPPED_ITEMS: [],
  PRIORITIZED_ITEMS: [],
  ENABLED_JOBS: ["issue-worker", "ci-fixer"],
  ALLOWED_REPOS: ["repo1", "repo2"],
  JOB_AI: {},
}));

vi.mock("./webhooks.js", () => ({
  verifyWebhookSignature: vi.fn().mockReturnValue(true),
  handleWebhookEvent: vi.fn().mockReturnValue({ action: "ignored" }),
}));

vi.mock("./oauth.js", () => ({
  isOAuthConfigured: vi.fn().mockReturnValue(false),
  getAuthorizationUrl: vi.fn().mockReturnValue("https://github.com/login/oauth/authorize?test=1"),
  exchangeCodeForUser: vi.fn().mockResolvedValue(null),
  createSessionCookie: vi.fn().mockReturnValue("mock-session-cookie"),
  verifySessionCookie: vi.fn().mockReturnValue(null),
}));

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./version.js", () => ({
  VERSION: "1.2.3-test",
}));

vi.mock("./claude.js", () => ({
  queueStatus: vi.fn().mockReturnValue({ pending: 2, active: 1 }),
  copilotQueueStatus: vi.fn().mockReturnValue({ pending: 0, active: 0 }),
  codexQueueStatus: vi.fn().mockReturnValue({ pending: 0, active: 0 }),
  cancelCurrentTask: vi.fn().mockReturnValue(true),
}));

vi.mock("./discord.js", () => ({
  discordStatus: vi.fn(() => ({ configured: false, connected: false, lastResult: null })),
}));

vi.mock("./github-app.js", () => ({
  isGitHubAppConfigured: vi.fn().mockReturnValue(false),
  getAppSlug: vi.fn().mockReturnValue(null),
}));

vi.mock("./notify.js", () => ({
  notificationEmitter: new EventEmitter(),
}));

vi.mock("./quiesce.js", () => ({
  isUpdatePending: vi.fn().mockReturnValue(false),
  pendingUpdateTag: vi.fn().mockReturnValue(null),
  clearQuiesce: vi.fn(),
}));

vi.mock("./sysstats.js", () => ({
  getSystemStats: vi.fn().mockReturnValue({
    cpuPercent: 12, cpuCount: 4, load: [0.5, 0.4, 0.3],
    memTotal: 8_000_000_000, memUsed: 3_000_000_000,
    diskTotal: 50_000_000_000, diskUsed: 20_000_000_000,
  }),
}));

vi.mock("./github.js", () => ({
  getQueueSnapshot: vi.fn().mockReturnValue({ items: [], oldestFetchAt: null }),
  enrichQueueItemsWithPRStatus: vi.fn().mockResolvedValue(undefined),
  mergePR: vi.fn().mockResolvedValue(undefined),
  removeQueueItem: vi.fn(),
  listRepos: vi.fn().mockResolvedValue([
    { owner: "owner1", name: "repo1", fullName: "owner1/repo1", defaultBranch: "main" },
  ]),
  listAllOrgRepos: vi.fn().mockResolvedValue([
    { owner: "owner1", name: "repo1", fullName: "owner1/repo1", defaultBranch: "main" },
    { owner: "owner1", name: "repo2", fullName: "owner1/repo2", defaultBranch: "main" },
  ]),
}));

vi.mock("./db.js", () => ({
  getRecentJobRuns: vi.fn().mockReturnValue([
    { run_id: "abc-123", job_name: "issue-worker", status: "completed", started_at: "2025-01-01 00:00:00", completed_at: "2025-01-01 00:01:00" },
    { run_id: "def-456", job_name: "ci-fixer", status: "failed", started_at: "2025-01-01 00:00:00", completed_at: "2025-01-01 00:00:30" },
  ]),
  getDistinctJobNames: vi.fn().mockReturnValue(["ci-fixer", "doc-maintainer", "issue-worker"]),
  getJobRun: vi.fn().mockImplementation((runId: string) => {
    if (runId === "abc-123") {
      return { run_id: "abc-123", job_name: "issue-worker", status: "completed", started_at: "2025-01-01 00:00:00", completed_at: "2025-01-01 00:01:00" };
    }
    if (runId === "running-456") {
      return { run_id: "running-456", job_name: "ci-fixer", status: "running", started_at: "2025-01-01 00:00:00", completed_at: null };
    }
    return undefined;
  }),
  getJobRunLogs: vi.fn().mockReturnValue([
    { id: 1, run_id: "abc-123", level: "info", message: "Starting", logged_at: "2025-01-01 00:00:00" },
  ]),
  getJobRunLogsSince: vi.fn().mockImplementation((_runId: string, afterId: number) => {
    if (afterId >= 1) return [];
    return [
      { id: 1, run_id: "abc-123", level: "info", message: "Starting", logged_at: "2025-01-01 00:00:00" },
    ];
  }),
  getLatestRunIdsByJob: vi.fn().mockReturnValue(
    new Map([
      ["issue-worker", { runId: "abc-123", status: "completed", startedAt: "2025-01-01 00:00:00", completedAt: "2025-01-01 00:01:00" }],
      ["ci-fixer", { runId: "def-456", status: "failed", startedAt: "2025-01-01 00:00:00", completedAt: "2025-01-01 00:00:30" }],
    ]),
  ),
  getRunningTasks: vi.fn().mockReturnValue([
    { id: 1, job_name: "issue-worker", repo: "org/repo", item_number: 42, trigger_label: "Refined", worktree_path: null, branch_name: null, run_id: null, status: "running", error: null, started_at: "2025-01-01 00:00:00", completed_at: null },
  ]),
  getTasksByRunId: vi.fn().mockReturnValue([]),
  getWorkItemsForRuns: vi.fn().mockReturnValue(new Map()),
  getRecentWorkItems: vi.fn().mockReturnValue([]),
  searchRunsByItem: vi.fn().mockReturnValue([]),
  getRunsForIssue: vi.fn().mockReturnValue([]),
  getLogsForRuns: vi.fn().mockReturnValue(new Map()),
  getRecentCompletedTasks: vi.fn().mockReturnValue([]),
  getRecentNotifications: vi.fn().mockReturnValue([]),
  getNotificationsSince: vi.fn().mockReturnValue([]),
  getLearnings: vi.fn().mockReturnValue([
    { id: 1, job_name: "issue-worker", repo: "org/repo", kind: "repo", summary: "test summary", status: "pending", reason: null, pr_number: null, created_at: "2025-01-01 00:00:00" },
  ]),
  countPendingLearnings: vi.fn().mockReturnValue(1),
  dismissLearning: vi.fn(),
}));

import { formatUptime, closeSSEConnections } from "./server.js";
import { createServer } from "./server.js";
import type { Scheduler } from "./scheduler.js";

function mockScheduler(): Scheduler {
  const _paused = new Set<string>();
  return {
    stop: vi.fn(),
    drain: vi.fn(),
    jobStates: vi.fn().mockReturnValue(
      new Map([
        ["issue-worker", true],
        ["ci-fixer", false],
      ]),
    ),
    triggerJob: vi.fn().mockReturnValue("started"),
    updateInterval: vi.fn(),
    updateScheduledHour: vi.fn(),
    pauseJob: vi.fn().mockImplementation((name: string) => {
      if (name === "issue-worker" || name === "ci-fixer") {
        _paused.add(name);
        return true;
      }
      return false;
    }),
    resumeJob: vi.fn().mockImplementation((name: string) => {
      if (name === "issue-worker" || name === "ci-fixer") {
        _paused.delete(name);
        return true;
      }
      return false;
    }),
    pausedJobs: vi.fn().mockImplementation(() => new Set(_paused)),
    jobScheduleInfo: vi.fn().mockReturnValue(
      new Map([
        ["issue-worker", { intervalMs: 300000 }],
        ["ci-fixer", { intervalMs: 600000 }],
      ]),
    ),
    addJob: vi.fn(),
    removeJob: vi.fn(),
  };
}

function request(
  server: http.Server,
  method: string,
  path: string,
  options?: { headers?: Record<string, string>; body?: string },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      reject(new Error("Server not listening"));
      return;
    }
    const reqHeaders: Record<string, string> = { ...(options?.headers ?? {}) };
    if (options?.body && !reqHeaders["content-type"]) {
      reqHeaders["content-type"] = "application/x-www-form-urlencoded";
    }
    const req = http.request(
      { hostname: "127.0.0.1", port: addr.port, path, method, headers: reqHeaders },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += chunk.toString()));
        res.on("end", () =>
          resolve({ status: res.statusCode!, headers: res.headers, body }),
        );
      },
    );
    req.on("error", reject);
    if (options?.body) req.write(options.body);
    req.end();
  });
}

describe("formatUptime", () => {
  it("returns '0s' for 0 seconds", () => {
    expect(formatUptime(0)).toBe("0s");
  });

  it("formats seconds only", () => {
    expect(formatUptime(45)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatUptime(90)).toBe("1m 30s");
  });

  it("formats exactly 1 hour", () => {
    expect(formatUptime(3600)).toBe("1h 0s");
  });

  it("formats days, hours, minutes, seconds", () => {
    expect(formatUptime(90061)).toBe("1d 1h 1m 1s");
  });

  it("formats exactly 1 day", () => {
    expect(formatUptime(86400)).toBe("1d 0s");
  });
});

// ── JSON API (/api/*) ──

const API_JOBS = [
  { name: "issue-worker", intervalMs: 300000 },
  { name: "ci-fixer", intervalMs: 600000 },
];

describe("JSON API (auth disabled)", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(mockScheduler(), API_JOBS);
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("GET /api/session reports auth disabled + authenticated", async () => {
    const res = await request(server, "GET", "/api/session");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.authEnabled).toBe(false);
    expect(body.authenticated).toBe(true);
    expect(body.methods).toEqual({ token: false, oauth: false });
    expect(body.oauthLoginUrl).toBe("/auth/github");
  });

  it("GET /api/overview returns status + version + counts", async () => {
    const res = await request(server, "GET", "/api/overview");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.version).toBe("1.2.3-test");
    expect(body.jobs).toEqual({ "issue-worker": true, "ci-fixer": false });
    expect(body.claudeQueue).toEqual({ pending: 2, active: 1 });
    expect(body.runningTasks).toHaveLength(1);
    expect(body.counts.recentDone).toBe(1);
    expect(body.counts.recentFailed).toBe(1);
    expect(body.counts.running).toBe(1);
    expect(body.counts.queueBlockedByTier).toBe(0);
    expect(body.counts.pendingLearnings).toBe(1);
    expect(body.updatePending).toBe(false);
    expect(body.pendingUpdateTag).toBeNull();
    expect(body.system).toEqual({
      cpuPercent: 12, cpuCount: 4, load: [0.5, 0.4, 0.3],
      memTotal: 8_000_000_000, memUsed: 3_000_000_000,
      diskTotal: 50_000_000_000, diskUsed: 20_000_000_000,
    });
  });

  it("GET /api/jobs returns one entry per job", async () => {
    const res = await request(server, "GET", "/api/jobs");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(2);
    const iw = body.find((j: { name: string }) => j.name === "issue-worker");
    expect(iw.running).toBe(true);
    expect(iw.enabled).toBe(true);
    expect(iw.backend).toBe("claude");
    expect(iw.description).toContain("Implements");
    expect(iw.lastRun.runId).toBe("abc-123");
    expect(iw.schedule.intervalMs).toBe(300000);
  });

  it("GET /api/queue returns attention buckets + skipped", async () => {
    const res = await request(server, "GET", "/api/queue");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty("myAttention");
    expect(body).toHaveProperty("yetiAttention");
    expect(body.skipped).toEqual([]);
  });

  it("GET /api/runs returns runs + jobNames", async () => {
    const res = await request(server, "GET", "/api/runs");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.runs).toHaveLength(2);
    expect(body.jobNames).toContain("issue-worker");
  });

  it("GET /api/runs/:runId returns run + logs; 404 for unknown", async () => {
    const ok = await request(server, "GET", "/api/runs/abc-123");
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).run.run_id).toBe("abc-123");
    const missing = await request(server, "GET", "/api/runs/nope");
    expect(missing.status).toBe(404);
  });

  it("GET /api/runs/:runId/tail returns logs + status", async () => {
    const res = await request(server, "GET", "/api/runs/abc-123/tail?after=0");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe("completed");
    expect(Array.isArray(body.logs)).toBe(true);
  });

  it("GET /api/runs/issue validates params and returns runs", async () => {
    const bad = await request(server, "GET", "/api/runs/issue");
    expect(bad.status).toBe(400);
    const ok = await request(server, "GET", "/api/runs/issue?repo=org/repo&number=42");
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body).number).toBe(42);
  });

  it("GET /api/notifications returns an array", async () => {
    const res = await request(server, "GET", "/api/notifications");
    expect(res.status).toBe(200);
    expect(Array.isArray(JSON.parse(res.body))).toBe(true);
  });

  it("GET /api/config returns masked config values + envOverrides", async () => {
    const res = await request(server, "GET", "/api/config");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.values.githubOwners).toEqual(["owner1"]);
    expect(body.envOverrides).toEqual({});
  });

  it("POST /api/config drops env-overridden fields before writing", async () => {
    const configMod = await import("./config.js");
    (configMod.getEnvOverrides as ReturnType<typeof vi.fn>).mockReturnValueOnce({ logLevel: "YETI_LOG_LEVEL" });
    const res = await request(server, "POST", "/api/config", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ logLevel: "warn", maxPlanRounds: 5, _tab: "general" }),
    });
    expect(res.status).toBe(200);
    const write = (configMod as unknown as { writeConfig: ReturnType<typeof vi.fn> }).writeConfig;
    const lastArg = write.mock.calls.at(-1)![0];
    expect(lastArg).not.toHaveProperty("logLevel");
    expect(lastArg).toHaveProperty("maxPlanRounds", 5);
  });

  it("GET /api/repos returns repos + availableRepos", async () => {
    const res = await request(server, "GET", "/api/repos");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.repos).toHaveLength(1);
    expect(body.availableRepos.map((r: { name: string }) => r.name)).toContain("repo2");
  });

  it("POST /api/jobs/:name/trigger starts a job", async () => {
    const res = await request(server, "POST", "/api/jobs/issue-worker/trigger");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).result).toBe("started");
  });

  it("POST /api/jobs/:name/trigger returns 409 when an update is pending", async () => {
    const sched = mockScheduler();
    sched.triggerJob = vi.fn().mockReturnValue("update-pending");
    const s = createServer(sched, API_JOBS);
    await new Promise<void>((resolve) => { if (s.listening) resolve(); else s.on("listening", resolve); });
    try {
      const res = await request(s, "POST", "/api/jobs/issue-worker/trigger");
      expect(res.status).toBe(409);
      expect(JSON.parse(res.body).result).toBe("update-pending");
    } finally {
      await new Promise<void>((resolve, reject) => s.close((err) => (err ? reject(err) : resolve())));
    }
  });

  it("POST /api/jobs/:name/pause toggles pause then resume", async () => {
    const paused = await request(server, "POST", "/api/jobs/ci-fixer/pause");
    expect(JSON.parse(paused.body).result).toBe("paused");
    const resumed = await request(server, "POST", "/api/jobs/ci-fixer/pause");
    expect(JSON.parse(resumed.body).result).toBe("resumed");
  });

  it("POST /api/tasks/cancel cancels the active task", async () => {
    const res = await request(server, "POST", "/api/tasks/cancel");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).result).toBe("cancelled");
  });

  it("POST /api/config persists JSON body and echoes tab", async () => {
    const configMod = await import("./config.js");
    const res = await request(server, "POST", "/api/config", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ logLevel: "warn", _tab: "general" }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ saved: true, tab: "general" });
    expect((configMod as unknown as { writeConfig: ReturnType<typeof vi.fn> }).writeConfig)
      .toHaveBeenCalledWith(expect.objectContaining({ logLevel: "warn" }));
  });

  it("POST /api/queue/prioritize writes config", async () => {
    const configMod = await import("./config.js");
    const res = await request(server, "POST", "/api/queue/prioritize", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "org/repo", number: 7 }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).result).toBe("ok");
    expect((configMod as unknown as { writeConfig: ReturnType<typeof vi.fn> }).writeConfig)
      .toHaveBeenCalledWith(expect.objectContaining({ prioritizedItems: [{ repo: "org/repo", number: 7 }] }));
  });

  it("GET /api/learnings returns learnings as camelCase JSON", async () => {
    const res = await request(server, "GET", "/api/learnings");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual({
      id: 1, jobName: "issue-worker", repo: "org/repo", kind: "repo", summary: "test summary",
      status: "pending", reason: null, prNumber: null, createdAt: "2025-01-01 00:00:00",
    });
  });

  it("POST /api/learnings/:id/dismiss flips status", async () => {
    const dbMod = await import("./db.js");
    const res = await request(server, "POST", "/api/learnings/1/dismiss", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "not applicable" }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ result: "dismissed" });
    expect((dbMod as unknown as { dismissLearning: ReturnType<typeof vi.fn> }).dismissLearning)
      .toHaveBeenCalledWith(1, "not applicable");
  });

  it("POST /api/learnings/:id/dismiss with no body dismisses without a reason", async () => {
    const dbMod = await import("./db.js");
    const dismissLearning = (dbMod as unknown as { dismissLearning: ReturnType<typeof vi.fn> }).dismissLearning;
    dismissLearning.mockClear();

    const res = await request(server, "POST", "/api/learnings/1/dismiss");

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ result: "dismissed" });
    expect(dismissLearning).toHaveBeenCalledWith(1, undefined);
  });

  it("POST /api/learnings/:id/dismiss with malformed JSON dismisses without a reason", async () => {
    const dbMod = await import("./db.js");
    const dismissLearning = (dbMod as unknown as { dismissLearning: ReturnType<typeof vi.fn> }).dismissLearning;
    dismissLearning.mockClear();

    const res = await request(server, "POST", "/api/learnings/1/dismiss", {
      headers: { "content-type": "application/json" },
      body: "{not json",
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ result: "dismissed" });
    expect(dismissLearning).toHaveBeenCalledWith(1, undefined);
  });

  it("unknown /api route returns JSON 404", async () => {
    const res = await request(server, "GET", "/api/nope");
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: "not_found" });
  });
});

describe("JSON API (auth enabled)", () => {
  let server: http.Server;

  beforeEach(async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).AUTH_TOKEN = "test-secret-token";
    server = createServer(mockScheduler(), API_JOBS);
    await new Promise<void>((resolve) => {
      if (server.listening) resolve();
      else server.on("listening", resolve);
    });
  });

  afterEach(async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).AUTH_TOKEN = "";
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("GET /api/overview returns JSON 401 without credentials", async () => {
    const res = await request(server, "GET", "/api/overview");
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(res.body)).toEqual({ error: "unauthorized" });
  });

  it("GET /api/overview returns 200 with valid Bearer token", async () => {
    const res = await request(server, "GET", "/api/overview", {
      headers: { Authorization: "Bearer test-secret-token" },
    });
    expect(res.status).toBe(200);
  });

  it("GET /api/session never 401s and reports methods", async () => {
    const res = await request(server, "GET", "/api/session");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.authEnabled).toBe(true);
    expect(body.authenticated).toBe(false);
    expect(body.methods.token).toBe(true);
  });

  it("POST /api/login sets cookie for valid token, 401 for invalid", async () => {
    const ok = await request(server, "POST", "/api/login", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "test-secret-token" }),
    });
    expect(ok.status).toBe(200);
    expect(String(ok.headers["set-cookie"])).toContain("yeti_token=");
    const bad = await request(server, "POST", "/api/login", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong" }),
    });
    expect(bad.status).toBe(401);
    expect(JSON.parse(bad.body)).toEqual({ error: "invalid_token" });
  });

  it("POST /api/login over HTTP sets a browser-usable non-secure token cookie", async () => {
    const res = await request(server, "POST", "/api/login", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "test-secret-token" }),
    });
    const cookie = res.headers["set-cookie"]?.[0] ?? "";
    expect(cookie).toContain("yeti_token=test-secret-token");
    expect(cookie).not.toContain(" Secure");
  });

  it("POST /api/logout clears cookies", async () => {
    const res = await request(server, "POST", "/api/logout");
    expect(res.status).toBe(200);
    expect(String(res.headers["set-cookie"])).toContain("Max-Age=0");
  });
});

// ── Core daemon HTTP behavior (post-SPA cutover) ──

describe("core HTTP endpoints", () => {
  let server: http.Server;

  beforeEach(async () => {
    server = createServer(mockScheduler(), API_JOBS);
    await new Promise<void>((resolve) => { if (server.listening) resolve(); else server.on("listening", resolve); });
  });
  afterEach(async () => {
    closeSSEConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("GET /health returns ok + version + drain signals", async () => {
    const res = await request(server, "GET", "/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok", version: "1.2.3-test", activeTasks: 1, updatePending: false });
  });

  it("legacy HTML routes are gone (fall through to 404 without built assets)", async () => {
    for (const path of ["/", "/queue", "/jobs", "/config", "/logs", "/notifications", "/repos"]) {
      const res = await request(server, "GET", path);
      expect(res.status, `expected 404 for ${path}`).toBe(404);
    }
  });

  it("GET /auth/github redirects to /login when OAuth is not configured", async () => {
    const res = await request(server, "GET", "/auth/github");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/login");
  });

  it("GET /auth/logout clears cookies and redirects to /login", async () => {
    const res = await request(server, "GET", "/auth/logout");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/login");
    expect(String(res.headers["set-cookie"])).toContain("Max-Age=0");
  });

  it("POST /webhooks/github returns 404 when no secret configured", async () => {
    const res = await request(server, "POST", "/webhooks/github", { body: "{}" });
    expect(res.status).toBe(404);
  });

  it("POST /webhooks/github processes an event when secret is configured", async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).WEBHOOK_SECRET = "whsec";
    try {
      const res = await request(server, "POST", "/webhooks/github", {
        headers: { "x-hub-signature-256": "sha256=deadbeef", "x-github-event": "issues", "content-type": "application/json" },
        body: JSON.stringify({ action: "labeled" }),
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ result: "ignored" });
    } finally {
      (configMod as Record<string, unknown>).WEBHOOK_SECRET = "";
    }
  });
});

describe("SSE stream auth", () => {
  let server: http.Server;
  beforeEach(async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).AUTH_TOKEN = "test-secret-token";
    server = createServer(mockScheduler(), API_JOBS);
    await new Promise<void>((resolve) => { if (server.listening) resolve(); else server.on("listening", resolve); });
  });
  afterEach(async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).AUTH_TOKEN = "";
    closeSSEConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("GET /api/notifications/stream returns JSON 401 without credentials", async () => {
    const res = await request(server, "GET", "/api/notifications/stream");
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: "unauthorized" });
  });
});
