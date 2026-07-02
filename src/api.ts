import http from "node:http";
import { queueStatus, copilotQueueStatus, codexQueueStatus, cancelCurrentTask } from "./claude.js";
import * as config from "./config.js";
import { getConfigForDisplay, getEnvOverrides, writeConfig, LOG_LEVELS, type ConfigFile } from "./config.js";
import { getQueueSnapshot, enrichQueueItemsWithPRStatus, mergePR, removeQueueItem, listAllOrgRepos, listRepos, type QueueCategory } from "./github.js";
import {
  getRecentJobRuns, getRecentWorkItems, getDistinctJobNames, getJobRun, getJobRunLogs,
  getJobRunLogsSince, getLatestRunIdsByJob, getRunningTasks, getTasksByRunId, getWorkItemsForRuns,
  searchRunsByItem, getRunsForIssue, getLogsForRuns, getRecentCompletedTasks,
  getRecentNotifications, getNotificationsSince,
} from "./db.js";
import type { Scheduler } from "./scheduler.js";
import { msUntilHour } from "./scheduler.js";
import { discordStatus } from "./discord.js";
import { VERSION } from "./version.js";
import { isOAuthConfigured } from "./oauth.js";
import { JOB_DESCRIPTIONS, type JobInfo } from "./job-meta.js";
import { isUpdatePending, pendingUpdateTag } from "./quiesce.js";
import { readBody, parseCookies, safeCompare, isAuthEnabled, getSession, requireApiAuth, sendJson, tokenCookie } from "./http-util.js";

/** Maps don't survive JSON.stringify — flatten to a plain object for the wire. */
function mapToObject<V>(m: Map<string, V>): Record<string, V> {
  return Object.fromEntries(m);
}

const ALL_CATEGORIES: QueueCategory[] = ["ready", "needs-refinement", "refined", "needs-review-addressing", "auto-mergeable", "needs-triage", "needs-plan-review"];
const MY_ATTENTION_CATEGORIES: QueueCategory[] = ["ready"];
const YETI_ATTENTION_CATEGORIES: QueueCategory[] = ["needs-refinement", "refined", "needs-review-addressing", "auto-mergeable", "needs-triage", "needs-plan-review"];

// ── Shared payload builders (also used by legacy routes during migration) ──

/** Compute the next-run countdown (ms) for a job, or null when paused/unknown. */
function computeNextRunIn(
  sched: { intervalMs?: number; scheduledHour?: number } | undefined,
  latest: { startedAt: string } | undefined,
  paused: boolean,
): number | null {
  if (paused || !sched) return null;
  if (sched.scheduledHour !== undefined) return msUntilHour(sched.scheduledHour);
  if (sched.intervalMs === undefined) return null;
  if (latest?.startedAt) {
    return Math.max(0, new Date(latest.startedAt + "Z").getTime() + sched.intervalMs - Date.now());
  }
  return sched.intervalMs;
}

export function buildStatusPayload(scheduler: Scheduler, startedAt: string): Record<string, unknown> {
  const uptimeMs = Date.now() - new Date(startedAt).getTime();
  const jobs: Record<string, boolean> = {};
  for (const [name, running] of scheduler.jobStates()) jobs[name] = running;

  const cq = queueStatus();
  const cpq = copilotQueueStatus();
  const cxq = codexQueueStatus();
  const runningTasks = getRunningTasks().map(t => ({
    jobName: t.job_name, repo: t.repo, itemNumber: t.item_number, startedAt: t.started_at,
  }));
  const latestRuns = getLatestRunIdsByJob();
  const schedInfo = scheduler.jobScheduleInfo();
  const pausedSet = scheduler.pausedJobs();

  const jobSchedules: Record<string, { intervalMs?: number; scheduledHour?: number; lastCompletedAt: string | null; nextRunIn: number | null }> = {};
  for (const [name] of scheduler.jobStates()) {
    const sched = schedInfo.get(name);
    const latest = latestRuns.get(name);
    const lastCompletedAt = latest?.completedAt ? latest.completedAt + "Z" : null;
    jobSchedules[name] = {
      ...(sched?.scheduledHour !== undefined ? { scheduledHour: sched.scheduledHour } : { intervalMs: sched?.intervalMs }),
      lastCompletedAt,
      nextRunIn: computeNextRunIn(sched, latest, pausedSet.has(name)),
    };
  }

  return {
    status: "ok",
    startedAt,
    uptime: Math.floor(uptimeMs / 1000),
    jobs,
    pausedJobs: [...pausedSet],
    claudeQueue: { pending: cq.pending, active: cq.active },
    copilotQueue: { pending: cpq.pending, active: cpq.active },
    codexQueue: { pending: cxq.pending, active: cxq.active },
    runningTasks,
    jobSchedules,
    jobAi: config.JOB_AI,
    discord: discordStatus(),
  };
}

function buildOverviewPayload(scheduler: Scheduler, startedAt: string): Record<string, unknown> {
  const status = buildStatusPayload(scheduler, startedAt);
  const recentRuns = getRecentJobRuns(50);
  let recentDone = 0;
  let recentFailed = 0;
  for (const r of recentRuns) {
    if (r.status === "completed") recentDone++;
    else if (r.status === "failed") recentFailed++;
  }
  const counts = {
    running: (status.runningTasks as unknown[]).length,
    queuePending: getQueueSnapshot(ALL_CATEGORIES).items.length,
    recentDone,
    recentFailed,
  };
  return { ...status, version: VERSION, counts, updatePending: isUpdatePending(), pendingUpdateTag: pendingUpdateTag() };
}

function buildJobsPayload(scheduler: Scheduler, allJobs: JobInfo[]): unknown[] {
  const running = scheduler.jobStates();
  const paused = scheduler.pausedJobs();
  const schedInfo = scheduler.jobScheduleInfo();
  const latestRuns = getLatestRunIdsByJob();
  const enabled = new Set(config.ENABLED_JOBS);
  const jobAi = config.JOB_AI;

  return allJobs.map(job => {
    const { name } = job;
    const sched = schedInfo.get(name) ?? { intervalMs: job.intervalMs, scheduledHour: job.scheduledHour };
    const latest = latestRuns.get(name);
    const ai = jobAi[name];
    return {
      name,
      description: JOB_DESCRIPTIONS[name] ?? "",
      enabled: enabled.has(name),
      running: running.get(name) ?? false,
      paused: paused.has(name),
      backend: ai?.backend ?? "claude",
      model: ai?.model ?? null,
      schedule: sched.scheduledHour !== undefined ? { scheduledHour: sched.scheduledHour } : { intervalMs: sched.intervalMs },
      lastRun: latest ? { runId: latest.runId, status: latest.status, startedAt: latest.startedAt, completedAt: latest.completedAt } : null,
      nextRunIn: computeNextRunIn(sched, latest, paused.has(name)),
    };
  });
}

// ── Config update validation (JSON body) ──

function buildConfigUpdate(body: unknown): { updates: Partial<ConfigFile>; tab: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const updates: Partial<ConfigFile> = {};
  const tab = typeof b._tab === "string" ? b._tab : "general";

  const posInt = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
  const nonNegInt = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  const strArray = (v: unknown) => (Array.isArray(v) ? v.map(String).map(s => s.trim()).filter(Boolean) : undefined);

  // General
  if (strArray(b.githubOwners)) updates.githubOwners = strArray(b.githubOwners)!;
  if (typeof b.selfRepo === "string") updates.selfRepo = b.selfRepo;
  if (posInt(b.logRetentionDays) !== undefined) updates.logRetentionDays = b.logRetentionDays as number;
  if (nonNegInt(b.logRetentionPerJob) !== undefined) updates.logRetentionPerJob = b.logRetentionPerJob as number;
  if (typeof b.logLevel === "string" && (LOG_LEVELS as readonly string[]).includes(b.logLevel)) {
    updates.logLevel = b.logLevel as ConfigFile["logLevel"];
  }
  if (posInt(b.queueScanIntervalMs) !== undefined) updates.queueScanIntervalMs = b.queueScanIntervalMs as number;

  // Integrations
  if (typeof b.discordBotToken === "string") updates.discordBotToken = b.discordBotToken;
  if (typeof b.discordChannelId === "string") updates.discordChannelId = b.discordChannelId;
  if (strArray(b.discordAllowedUsers)) updates.discordAllowedUsers = strArray(b.discordAllowedUsers)!;

  // Jobs & Repos
  if (strArray(b.enabledJobs)) updates.enabledJobs = strArray(b.enabledJobs)!;
  if (strArray(b.allowedRepos)) updates.allowedRepos = strArray(b.allowedRepos)!;
  if (typeof b.includeForks === "boolean") updates.includeForks = b.includeForks;
  if (typeof b.reviewLoop === "boolean") updates.reviewLoop = b.reviewLoop;
  if (typeof b.maxPlanRounds === "number" && Number.isFinite(b.maxPlanRounds) && b.maxPlanRounds >= 1) {
    updates.maxPlanRounds = b.maxPlanRounds;
  }

  // Intervals (ms, each > 0) & Schedules (hour 0..23)
  if (b.intervals && typeof b.intervals === "object") {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(b.intervals as Record<string, unknown>)) {
      if (posInt(v) !== undefined) out[k] = v as number;
    }
    if (Object.keys(out).length) updates.intervals = out as ConfigFile["intervals"];
  }
  if (b.schedules && typeof b.schedules === "object") {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(b.schedules as Record<string, unknown>)) {
      if (typeof v === "number" && v >= 0 && v <= 23) out[k] = v;
    }
    if (Object.keys(out).length) updates.schedules = out as ConfigFile["schedules"];
  }

  // AI backends
  if (nonNegInt(b.maxClaudeWorkers) !== undefined) updates.maxClaudeWorkers = b.maxClaudeWorkers as number;
  if (posInt(b.claudeTimeoutMs) !== undefined) updates.claudeTimeoutMs = b.claudeTimeoutMs as number;
  if (nonNegInt(b.maxCopilotWorkers) !== undefined) updates.maxCopilotWorkers = b.maxCopilotWorkers as number;
  if (posInt(b.copilotTimeoutMs) !== undefined) updates.copilotTimeoutMs = b.copilotTimeoutMs as number;
  if (nonNegInt(b.maxCodexWorkers) !== undefined) updates.maxCodexWorkers = b.maxCodexWorkers as number;
  if (posInt(b.codexTimeoutMs) !== undefined) updates.codexTimeoutMs = b.codexTimeoutMs as number;

  if (b.jobAi && typeof b.jobAi === "object") {
    const out: Record<string, { backend?: "claude" | "copilot" | "codex"; model?: string }> = {};
    for (const [job, val] of Object.entries(b.jobAi as Record<string, unknown>)) {
      if (!val || typeof val !== "object") continue;
      const entry = val as Record<string, unknown>;
      const cleaned: { backend?: "claude" | "copilot" | "codex"; model?: string } = {};
      if (entry.backend === "claude" || entry.backend === "copilot" || entry.backend === "codex") cleaned.backend = entry.backend;
      if (typeof entry.model === "string") cleaned.model = entry.model || undefined;
      out[job] = cleaned;
    }
    if (Object.keys(out).length) updates.jobAi = out;
  }

  // Auth (empty string is ignored by writeConfig's sensitive-key guard)
  if (typeof b.authToken === "string") updates.authToken = b.authToken;

  return { updates, tab };
}

// ── Router ──

/** Handle any request under /api/*. Always sends a response. */
export async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  scheduler: Scheduler,
  allJobs: JobInfo[],
  startedAt: string,
): Promise<void> {
  const urlObj = new URL(req.url ?? "/", "http://localhost");
  const p = urlObj.pathname;
  const method = req.method ?? "GET";

  // ── Public: session probe (never 401s) ──
  if (method === "GET" && p === "/api/session") {
    const session = getSession(req);
    sendJson(res, 200, {
      authEnabled: isAuthEnabled(),
      authenticated: !!session,
      username: session?.username ?? null,
      methods: { token: !!config.AUTH_TOKEN, oauth: isOAuthConfigured() },
      oauthLoginUrl: "/auth/github",
    });
    return;
  }

  // ── Public: token login ──
  if (method === "POST" && p === "/api/login") {
    const body = await readBody(req);
    let token = "";
    try { token = String((JSON.parse(body) as { token?: unknown }).token ?? ""); } catch { /* invalid json */ }
    const authToken = config.AUTH_TOKEN;
    if (!authToken || !safeCompare(token, authToken)) {
      sendJson(res, 401, { error: "invalid_token" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": tokenCookie(token, req),
    });
    res.end(JSON.stringify({ ok: true, username: null }));
    return;
  }

  // ── Public: logout (clears cookies) ──
  if (method === "POST" && p === "/api/logout") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": [
        `yeti_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
        `yeti_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      ],
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Everything below requires auth ──

  // POST mutations
  if (method === "POST") {
    if (!requireApiAuth(req, res)) return;

    // /api/jobs/:name/trigger  and  /api/jobs/:name/pause
    const jobMatch = /^\/api\/jobs\/(.+)\/(trigger|pause)$/.exec(p);
    if (jobMatch) {
      const jobName = decodeURIComponent(jobMatch[1]);
      const action = jobMatch[2];
      if (action === "trigger") {
        const result = scheduler.triggerJob(jobName);
        const status = result === "started" ? 200 : result === "unknown" ? 404 : 409;
        sendJson(res, status, { result });
        return;
      }
      // pause toggles pause/resume and persists
      const paused = scheduler.pausedJobs();
      if (paused.has(jobName)) {
        if (!scheduler.resumeJob(jobName)) { sendJson(res, 404, { result: "unknown" }); return; }
        writeConfig({ pausedJobs: [...scheduler.pausedJobs()] });
        sendJson(res, 200, { result: "resumed" });
      } else {
        if (!scheduler.pauseJob(jobName)) { sendJson(res, 404, { result: "unknown" }); return; }
        writeConfig({ pausedJobs: [...scheduler.pausedJobs()] });
        sendJson(res, 200, { result: "paused" });
      }
      return;
    }

    if (p === "/api/tasks/cancel") {
      const cancelled = cancelCurrentTask();
      sendJson(res, 200, { result: cancelled ? "cancelled" : "no-active-task" });
      return;
    }

    if (p === "/api/queue/merge") {
      try {
        const { repo, prNumber } = JSON.parse(await readBody(req)) as { repo: string; prNumber: number };
        if (!repo || !prNumber) throw new Error("Missing repo or prNumber");
        await mergePR(repo, prNumber);
        sendJson(res, 200, { result: "merged" });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    const queueOps = {
      "/api/queue/skip": { configKey: "skippedItems" as const, sourceList: () => config.SKIPPED_ITEMS, operation: "add" as const, afterWrite: (repo: string, number: number) => removeQueueItem(repo, number) },
      "/api/queue/unskip": { configKey: "skippedItems" as const, sourceList: () => config.SKIPPED_ITEMS, operation: "remove" as const, afterWrite: undefined },
      "/api/queue/prioritize": { configKey: "prioritizedItems" as const, sourceList: () => config.PRIORITIZED_ITEMS, operation: "add" as const, afterWrite: undefined },
      "/api/queue/deprioritize": { configKey: "prioritizedItems" as const, sourceList: () => config.PRIORITIZED_ITEMS, operation: "remove" as const, afterWrite: undefined },
    };
    const op = queueOps[p as keyof typeof queueOps];
    if (op) {
      try {
        const { repo, number } = JSON.parse(await readBody(req)) as { repo: string; number: number };
        if (!repo || !number) throw new Error("Missing repo or number");
        const current = op.sourceList() as Array<{ repo: string; number: number }>;
        const items = op.operation === "add"
          ? (current.some(i => i.repo === repo && i.number === number) ? [...current] : [...current, { repo, number }])
          : current.filter(i => !(i.repo === repo && i.number === number));
        writeConfig({ [op.configKey]: items });
        op.afterWrite?.(repo, number);
        sendJson(res, 200, { result: "ok" });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    if (p === "/api/repos") {
      try {
        const { repo } = JSON.parse(await readBody(req)) as { repo: string };
        if (!repo) throw new Error("Missing repo name");
        const current = config.ALLOWED_REPOS;
        if (current === null) {
          const allRepos = await listRepos();
          const names = allRepos.map(r => r.name);
          if (!names.includes(repo)) names.push(repo);
          writeConfig({ allowedRepos: names });
        } else if (!current.includes(repo)) {
          writeConfig({ allowedRepos: [...current, repo] });
        }
        sendJson(res, 200, { result: "added" });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    if (p === "/api/config") {
      try {
        const { updates, tab } = buildConfigUpdate(JSON.parse(await readBody(req)));
        // Env-overridden fields are locked — writing them to the file would be a no-op
        // (env wins at load) and misleading, so drop them.
        for (const field of Object.keys(getEnvOverrides())) {
          delete (updates as Record<string, unknown>)[field];
        }
        writeConfig(updates);
        const newToken = config.AUTH_TOKEN;
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (newToken) headers["Set-Cookie"] = tokenCookie(newToken, req);
        res.writeHead(200, headers);
        res.end(JSON.stringify({ saved: true, tab }));
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }

    sendJson(res, 404, { error: "not_found" });
    return;
  }

  // GET data (auth required)
  if (method === "GET") {
    if (!requireApiAuth(req, res)) return;

    if (p === "/api/overview") { sendJson(res, 200, buildOverviewPayload(scheduler, startedAt)); return; }

    if (p === "/api/jobs") { sendJson(res, 200, buildJobsPayload(scheduler, allJobs)); return; }

    if (p === "/api/queue") {
      const myAttention = getQueueSnapshot(MY_ATTENTION_CATEGORIES);
      const yetiAttention = getQueueSnapshot(YETI_ATTENTION_CATEGORIES);
      await enrichQueueItemsWithPRStatus(myAttention.items);
      sendJson(res, 200, {
        myAttention: myAttention.items,
        yetiAttention: yetiAttention.items,
        skipped: config.SKIPPED_ITEMS,
        oldestFetchAt: Math.min(...[myAttention.oldestFetchAt, yetiAttention.oldestFetchAt].filter((x): x is number => x !== null)) || null,
      });
      return;
    }

    // /api/runs/issue?repo=&number=  (must precede /api/runs/:runId)
    if (p === "/api/runs/issue") {
      const repo = urlObj.searchParams.get("repo");
      const num = parseInt(urlObj.searchParams.get("number") ?? "", 10);
      if (!repo || !Number.isFinite(num) || num < 1) { sendJson(res, 400, { error: "invalid repo/number" }); return; }
      const runs = getRunsForIssue(repo, num);
      const runIds = runs.map(r => r.run_id);
      sendJson(res, 200, { repo, number: num, runs, logsByRun: mapToObject(getLogsForRuns(runIds)), workItems: mapToObject(getWorkItemsForRuns(runIds)) });
      return;
    }

    // /api/runs/:runId/tail?after=N
    const tailMatch = /^\/api\/runs\/(.+)\/tail$/.exec(p);
    if (tailMatch) {
      const runId = decodeURIComponent(tailMatch[1]);
      const afterId = parseInt(urlObj.searchParams.get("after") ?? "0", 10) || 0;
      const run = getJobRun(runId);
      if (!run) { sendJson(res, 404, { error: "Run not found" }); return; }
      const logs = getJobRunLogsSince(runId, afterId);
      sendJson(res, 200, {
        status: run.status,
        completed_at: run.completed_at,
        logs: logs.map(l => ({ id: l.id, level: l.level, message: l.message, logged_at: l.logged_at })),
      });
      return;
    }

    // /api/runs/:runId
    const runMatch = /^\/api\/runs\/([^/]+)$/.exec(p);
    if (runMatch) {
      const runId = decodeURIComponent(runMatch[1]);
      const run = getJobRun(runId);
      if (!run) { sendJson(res, 404, { error: "Run not found" }); return; }
      sendJson(res, 200, { run, logs: getJobRunLogs(runId), tasks: getTasksByRunId(runId) });
      return;
    }

    // /api/runs?job=&search=&limit=
    if (p === "/api/runs") {
      const jobFilter = urlObj.searchParams.get("job");
      const search = urlObj.searchParams.get("search") ?? undefined;
      const limit = parseInt(urlObj.searchParams.get("limit") ?? "50", 10) || 50;
      const runs = search ? searchRunsByItem(search) : getRecentJobRuns(limit, jobFilter ?? undefined);
      sendJson(res, 200, {
        runs,
        jobNames: getDistinctJobNames(),
        workItems: mapToObject(getWorkItemsForRuns(runs.map(r => r.run_id))),
        recentItems: search ? [] : getRecentWorkItems(),
      });
      return;
    }

    if (p === "/api/notifications") {
      const after = parseInt(urlObj.searchParams.get("after") ?? "", 10);
      const rows = Number.isFinite(after) ? getNotificationsSince(after) : getRecentNotifications(50);
      sendJson(res, 200, rows.map(r => ({
        id: r.id, jobName: r.job_name, message: r.message, url: r.url, level: r.level, createdAt: r.created_at,
      })));
      return;
    }

    if (p === "/api/config") { sendJson(res, 200, { values: getConfigForDisplay(), envOverrides: getEnvOverrides() }); return; }

    if (p === "/api/repos") {
      const repos = await listRepos();
      const allOrgRepos = await listAllOrgRepos();
      const snapshot = getQueueSnapshot(ALL_CATEGORIES);
      await enrichQueueItemsWithPRStatus(snapshot.items);
      const configuredNames = new Set(repos.map(r => r.name.toLowerCase()));
      sendJson(res, 200, {
        repos,
        queueItems: snapshot.items,
        recentTasks: getRecentCompletedTasks(50),
        availableRepos: allOrgRepos.filter(r => !configuredNames.has(r.name.toLowerCase())),
        allowedReposIsNull: config.ALLOWED_REPOS === null,
      });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
    return;
  }

  sendJson(res, 405, { error: "method_not_allowed" });
}

// Re-export so server.ts can reference cookie parsing consistency if needed.
export { parseCookies };
