import http from "node:http";
import crypto from "node:crypto";
import { queueStatus, copilotQueueStatus, codexQueueStatus, cancelCurrentTask } from "./claude.js";
import { SERVER_PORT, getConfigForDisplay, writeConfig, type ConfigFile } from "./config.js";
import * as config from "./config.js";
import { getQueueSnapshot, enrichQueueItemsWithPRStatus, mergePR, removeQueueItem, listAllOrgRepos, listRepos, type QueueCategory } from "./github.js";
import { getRecentJobRuns, getRecentWorkItems, getDistinctJobNames, getJobRun, getJobRunLogs, getJobRunLogsSince, getLatestRunIdsByJob, getRunningTasks, getTasksByRunId, getWorkItemsForRuns, searchRunsByItem, getRunsForIssue, getLogsForRuns, getRecentCompletedTasks } from "./db.js";
import * as log from "./log.js";
import type { Scheduler } from "./scheduler.js";
import { msUntilHour } from "./scheduler.js";
import { discordStatus } from "./discord.js";
import { VERSION } from "./version.js";
import { buildStatusPage } from "./pages/dashboard.js";
import { buildQueuePage } from "./pages/queue.js";
import { buildLogsListPage, buildLogDetailPage, buildIssueLogsPage } from "./pages/logs.js";
import { buildConfigPage, VALID_TABS, type TabId } from "./pages/config.js";
import { buildJobsPage, type JobInfo } from "./pages/jobs.js";
import { buildLoginPage } from "./pages/login.js";
import { buildReposPage } from "./pages/repos.js";
import { isOAuthConfigured, getAuthorizationUrl, exchangeCodeForUser, createSessionCookie, verifySessionCookie } from "./oauth.js";
import { verifyWebhookSignature, handleWebhookEvent } from "./webhooks.js";

// Re-export for backwards compatibility with tests and other consumers
export { formatUptime, formatRelativeTime } from "./pages/layout.js";
export type { Theme } from "./pages/layout.js";
export { buildQueuePage } from "./pages/queue.js";
export { buildLogsListPage, buildLogDetailPage, buildIssueLogsPage } from "./pages/logs.js";

const startedAt = new Date().toISOString();

// ── Queue page category groups ──

const MY_ATTENTION_CATEGORIES: QueueCategory[] = ["ready"];
const YETI_ATTENTION_CATEGORIES: QueueCategory[] = ["needs-refinement", "refined", "needs-review-addressing", "auto-mergeable", "needs-triage", "needs-plan-review"];

// ── Auth helpers ──

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return cookies;
}

function isAuthEnabled(): boolean {
  return !!(config.AUTH_TOKEN || isOAuthConfigured());
}

/** Returns false if unauthorized (response already sent), or { username } if authorized. */
function requireAuth(req: http.IncomingMessage, res: http.ServerResponse): false | { username: string | null } {
  if (!isAuthEnabled()) return { username: null };

  const token = config.AUTH_TOKEN;

  // Check Authorization header
  if (token) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const provided = authHeader.slice(7);
      if (safeCompare(provided, token)) return { username: null };
    }
  }

  // Check token cookie
  if (token) {
    const cookies = parseCookies(req.headers.cookie);
    const cookieToken = cookies["yeti_token"];
    if (cookieToken && safeCompare(cookieToken, token)) return { username: null };
  }

  // Check OAuth session cookie
  if (isOAuthConfigured()) {
    const cookies = parseCookies(req.headers.cookie);
    const sessionCookie = cookies["yeti_session"];
    if (sessionCookie) {
      const session = verifySessionCookie(sessionCookie);
      if (session) return { username: session.login };
    }
  }

  // Auth failed
  res.writeHead(401, { "Content-Type": "text/html" });
  res.end(`<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=/login"></head><body>Redirecting to login...</body></html>`);
  return false;
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function readBody(req: http.IncomingMessage, maxBytes = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function readRawBody(req: http.IncomingMessage, maxBytes = 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseFormBody(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of body.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    params[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
  }
  return params;
}

// ── Server ──

export function createServer(scheduler: Scheduler, allJobs: JobInfo[] = []): http.Server {
  const server = http.createServer(async (req, res) => {
    try {
      await handleRequest(req, res, scheduler, allJobs);
    } catch (err) {
      log.error(`HTTP handler error: ${err}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      }
    }
  });

  server.listen(SERVER_PORT, () => {
    log.info(`HTTP server listening on port ${SERVER_PORT}`);
  });

  return server;
}

function getTheme(req: http.IncomingMessage): "dark" | "light" | "system" {
  const cookies = parseCookies(req.headers.cookie);
  const value = cookies["yeti_theme"];
  if (value === "dark" || value === "light") return value;
  return "system";
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, scheduler: Scheduler, allJobs: JobInfo[]): Promise<void> {
  const theme = getTheme(req);

  // ── POST routes ──

  // Webhook endpoint — HMAC auth only, no OAuth/token required
  if (req.method === "POST" && req.url === "/webhooks/github") {
    if (!config.WEBHOOK_SECRET) {
      res.writeHead(404).end();
      return;
    }
    const rawBody = await readRawBody(req);
    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    if (!signature || !verifyWebhookSignature(config.WEBHOOK_SECRET, rawBody, signature)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid signature" }));
      return;
    }
    const event = req.headers["x-github-event"] as string | undefined;
    if (!event) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing X-GitHub-Event header" }));
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf-8"));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid JSON" }));
      return;
    }
    const result = handleWebhookEvent(event, payload, scheduler);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result: result.action }));
    return;
  }

  if (req.method === "POST" && req.url === "/login") {
    const body = await readBody(req);
    const params = parseFormBody(body);
    const token = params["token"] ?? "";
    const authToken = config.AUTH_TOKEN;

    if (!authToken || !safeCompare(token, authToken)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(buildLoginPage({
        tokenError: true,
        theme,
        hasToken: !!config.AUTH_TOKEN,
        hasOAuth: isOAuthConfigured(),
      }));
      return;
    }

    res.writeHead(303, {
      Location: "/",
      "Set-Cookie": `yeti_token=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/`,
    });
    res.end();
    return;
  }

  if (req.method === "POST" && req.url?.startsWith("/trigger/")) {
    if (!requireAuth(req, res)) return;

    const jobName = decodeURIComponent(req.url.slice("/trigger/".length));
    const result = scheduler.triggerJob(jobName);
    const status = result === "started" ? 200 : result === "already-running" ? 409 : 404;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result }));
    return;
  }

  if (req.method === "POST" && req.url?.startsWith("/pause/")) {
    if (!requireAuth(req, res)) return;
    const jobName = decodeURIComponent(req.url.slice("/pause/".length));
    const paused = scheduler.pausedJobs();
    let result: string;
    if (paused.has(jobName)) {
      if (!scheduler.resumeJob(jobName)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: "unknown" }));
        return;
      }
      const updated = [...scheduler.pausedJobs()];
      writeConfig({ pausedJobs: updated });
      result = "resumed";
    } else {
      if (!scheduler.pauseJob(jobName)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: "unknown" }));
        return;
      }
      const updated = [...scheduler.pausedJobs()];
      writeConfig({ pausedJobs: updated });
      result = "paused";
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result }));
    return;
  }

  if (req.method === "POST" && req.url === "/cancel") {
    if (!requireAuth(req, res)) return;
    const cancelled = cancelCurrentTask();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ result: cancelled ? "cancelled" : "no-active-task" }));
    return;
  }

  if (req.method === "POST" && req.url === "/queue/merge") {
    if (!requireAuth(req, res)) return;
    try {
      const body = await readBody(req);
      const { repo, prNumber } = JSON.parse(body) as { repo: string; prNumber: number };
      if (!repo || !prNumber) throw new Error("Missing repo or prNumber");
      await mergePR(repo, prNumber);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: "merged" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  for (const { url, configKey, sourceList, operation, afterWrite } of [
    { url: "/queue/skip", configKey: "skippedItems" as const, sourceList: () => config.SKIPPED_ITEMS, operation: "add" as const, afterWrite: (repo: string, number: number) => removeQueueItem(repo, number) },
    { url: "/queue/unskip", configKey: "skippedItems" as const, sourceList: () => config.SKIPPED_ITEMS, operation: "remove" as const },
    { url: "/queue/prioritize", configKey: "prioritizedItems" as const, sourceList: () => config.PRIORITIZED_ITEMS, operation: "add" as const },
    { url: "/queue/deprioritize", configKey: "prioritizedItems" as const, sourceList: () => config.PRIORITIZED_ITEMS, operation: "remove" as const },
  ] as const) {
    if (req.method === "POST" && req.url === url) {
      if (!requireAuth(req, res)) return;
      try {
        const body = await readBody(req);
        const { repo, number } = JSON.parse(body) as { repo: string; number: number };
        if (!repo || !number) throw new Error("Missing repo or number");
        const current = sourceList() as Array<{ repo: string; number: number }>;
        const items = operation === "add"
          ? current.some((i) => i.repo === repo && i.number === number) ? [...current] : [...current, { repo, number }]
          : current.filter((i) => !(i.repo === repo && i.number === number));
        writeConfig({ [configKey]: items });
        afterWrite?.(repo, number);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: "ok" }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }
  }

  if (req.method === "POST" && req.url === "/repos/add") {
    if (!requireAuth(req, res)) return;
    try {
      const body = await readBody(req);
      const { repo } = JSON.parse(body) as { repo: string };
      if (!repo) throw new Error("Missing repo name");
      const current = config.ALLOWED_REPOS;
      if (current === null) {
        // Convert from "all repos" to explicit list: fetch all current repos + new one
        const allRepos = await listRepos();
        const names = allRepos.map(r => r.name);
        if (!names.includes(repo)) names.push(repo);
        writeConfig({ allowedRepos: names });
      } else {
        if (!current.includes(repo)) {
          writeConfig({ allowedRepos: [...current, repo] });
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: "added" }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (req.method === "POST" && req.url === "/config") {
    if (!requireAuth(req, res)) return;

    const body = await readBody(req);
    const params = parseFormBody(body);
    const updates: Partial<ConfigFile> = {};

    // General
    if (params["githubOwners"] !== undefined) {
      updates.githubOwners = params["githubOwners"].split(",").map(s => s.trim()).filter(Boolean);
    }
    if (params["selfRepo"] !== undefined) updates.selfRepo = params["selfRepo"];
    if (params["logRetentionDays"] !== undefined) {
      const v = parseInt(params["logRetentionDays"], 10);
      if (v > 0) updates.logRetentionDays = v;
    }
    if (params["logRetentionPerJob"] !== undefined) {
      const v = parseInt(params["logRetentionPerJob"], 10);
      if (v >= 0) updates.logRetentionPerJob = v;
    }
    if (params["queueScanIntervalMs"] !== undefined) {
      const v = parseInt(params["queueScanIntervalMs"], 10);
      if (v > 0) updates.queueScanIntervalMs = v * 60 * 1000; // minutes → ms
    }

    // Integrations
    if (params["discordBotToken"] !== undefined) updates.discordBotToken = params["discordBotToken"];
    if (params["discordChannelId"] !== undefined) updates.discordChannelId = params["discordChannelId"];
    if (params["discordAllowedUsers"] !== undefined) {
      updates.discordAllowedUsers = params["discordAllowedUsers"].split(",").map(s => s.trim()).filter(Boolean);
    }
    // Jobs & Repos
    if (params["enabledJobs"] !== undefined) {
      updates.enabledJobs = params["enabledJobs"].split(",").map(s => s.trim()).filter(Boolean);
    }
    if (params["allowedRepos"] !== undefined) {
      updates.allowedRepos = params["allowedRepos"].split(",").map(s => s.trim()).filter(Boolean);
    }
    updates.includeForks = params["includeForks"] === "true";
    // Intervals
    const intervalUpdates: Record<string, number> = {};
    for (const [key, value] of Object.entries(params)) {
      if (key.startsWith("interval_")) {
        const intKey = key.slice("interval_".length);
        const v = parseInt(value, 10);
        if (v > 0) intervalUpdates[intKey] = v * 60 * 1000; // minutes → ms
      }
    }
    if (Object.keys(intervalUpdates).length > 0) {
      updates.intervals = intervalUpdates as ConfigFile["intervals"];
    }

    // Schedules
    const scheduleUpdates: Record<string, number> = {};
    for (const [key, value] of Object.entries(params)) {
      if (key.startsWith("schedule_")) {
        const schedKey = key.slice("schedule_".length);
        const v = parseInt(value, 10);
        if (v >= 0 && v <= 23) scheduleUpdates[schedKey] = v;
      }
    }
    if (Object.keys(scheduleUpdates).length > 0) {
      updates.schedules = scheduleUpdates as ConfigFile["schedules"];
    }

    // AI Backends
    if (params["maxCopilotWorkers"] !== undefined) {
      const v = parseInt(params["maxCopilotWorkers"], 10);
      if (v >= 0) updates.maxCopilotWorkers = v;
    }
    if (params["copilotTimeoutMs"] !== undefined) {
      const v = parseInt(params["copilotTimeoutMs"], 10);
      if (v > 0) updates.copilotTimeoutMs = v * 60 * 1000; // minutes → ms
    }
    if (params["maxCodexWorkers"] !== undefined) {
      const v = parseInt(params["maxCodexWorkers"], 10);
      if (v >= 0) updates.maxCodexWorkers = v;
    }
    if (params["codexTimeoutMs"] !== undefined) {
      const v = parseInt(params["codexTimeoutMs"], 10);
      if (v > 0) updates.codexTimeoutMs = v * 60 * 1000; // minutes → ms
    }
    // Parse jobAi_* fields (e.g. jobAi_plan-reviewer_backend, jobAi_plan-reviewer_model)
    const jobAiUpdates: Record<string, { backend?: "claude" | "copilot" | "codex"; model?: string }> = {};
    for (const [key, value] of Object.entries(params)) {
      if (!key.startsWith("jobAi_")) continue;
      const rest = key.slice("jobAi_".length);
      const lastUnderscore = rest.lastIndexOf("_");
      if (lastUnderscore < 0) continue;
      const jobName = rest.slice(0, lastUnderscore);
      const field = rest.slice(lastUnderscore + 1);
      if (!jobAiUpdates[jobName]) jobAiUpdates[jobName] = {};
      if (field === "backend" && (value === "claude" || value === "copilot" || value === "codex")) {
        jobAiUpdates[jobName].backend = value;
      } else if (field === "model") {
        jobAiUpdates[jobName].model = value || undefined;
      }
    }
    if (Object.keys(jobAiUpdates).length > 0) {
      updates.jobAi = jobAiUpdates;
    }

    // Auth
    if (params["authToken"] !== undefined) updates.authToken = params["authToken"];

    writeConfig(updates);

    // If auth token changed, set new cookie so user isn't locked out
    const newToken = config.AUTH_TOKEN;
    const tab = VALID_TABS.includes(params["_tab"] as TabId) ? params["_tab"] : "general";
    const headers: Record<string, string> = { Location: `/config?saved=1&tab=${tab}` };
    if (newToken) {
      headers["Set-Cookie"] = `yeti_token=${encodeURIComponent(newToken)}; HttpOnly; Secure; SameSite=Strict; Path=/`;
    }

    res.writeHead(303, headers);
    res.end();
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405).end();
    return;
  }

  // ── GET routes ──

  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: VERSION }));
    return;
  }

  if (req.url === "/login" || req.url?.startsWith("/login?")) {
    if (!isAuthEnabled()) {
      res.writeHead(303, { Location: "/" });
      res.end();
      return;
    }
    const urlObj = new URL(req.url, "http://localhost");
    const error = urlObj.searchParams.get("error") ?? undefined;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(buildLoginPage({
      tokenError: false,
      theme,
      hasToken: !!config.AUTH_TOKEN,
      hasOAuth: isOAuthConfigured(),
      oauthError: error,
    }));
    return;
  }

  // ── OAuth routes (public) ──

  if (req.url === "/auth/github") {
    if (!isOAuthConfigured()) {
      res.writeHead(302, { Location: "/login" });
      res.end();
      return;
    }
    const state = crypto.randomBytes(20).toString("hex");
    const isSecure = config.EXTERNAL_URL.startsWith("https://");
    const stateCookie = `yeti_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=300${isSecure ? "; Secure" : ""}`;
    res.writeHead(302, {
      Location: getAuthorizationUrl(state),
      "Set-Cookie": stateCookie,
    });
    res.end();
    return;
  }

  if (req.url?.startsWith("/auth/callback")) {
    if (!isOAuthConfigured()) {
      res.writeHead(302, { Location: "/login" });
      res.end();
      return;
    }
    const isSecure = config.EXTERNAL_URL.startsWith("https://");
    const clearStateCookie = `yeti_oauth_state=; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=0${isSecure ? "; Secure" : ""}`;

    const urlObj = new URL(req.url, "http://localhost");

    // Check if user denied consent
    if (urlObj.searchParams.get("error") === "access_denied") {
      res.writeHead(302, { Location: "/login?error=oauth_denied", "Set-Cookie": clearStateCookie });
      res.end();
      return;
    }

    const code = urlObj.searchParams.get("code");
    const state = urlObj.searchParams.get("state");

    if (!code) {
      res.writeHead(302, { Location: "/login?error=oauth_error", "Set-Cookie": clearStateCookie });
      res.end();
      return;
    }

    // Verify state matches cookie
    const cookies = parseCookies(req.headers.cookie);
    const cookieState = cookies["yeti_oauth_state"];
    if (!cookieState || !state || cookieState !== state) {
      res.writeHead(302, { Location: "/login?error=oauth_error", "Set-Cookie": clearStateCookie });
      res.end();
      return;
    }

    // Exchange code for user
    const result = await exchangeCodeForUser(code);

    if (!result || "error" in result) {
      const errorType = result && "error" in result && result.error === "not_org_member"
        ? "not_org_member"
        : "oauth_error";
      res.writeHead(302, { Location: `/login?error=${errorType}`, "Set-Cookie": clearStateCookie });
      res.end();
      return;
    }

    const user = result;

    // Set session cookie
    const sessionValue = createSessionCookie(user.login);
    const sessionCookie = `yeti_session=${sessionValue}; HttpOnly; SameSite=Strict; Path=/${isSecure ? "; Secure" : ""}; Max-Age=86400`;
    res.writeHead(302, {
      Location: "/",
      "Set-Cookie": [clearStateCookie, sessionCookie],
    });
    res.end();
    return;
  }

  if (req.url === "/auth/logout") {
    if (!isOAuthConfigured()) {
      res.writeHead(302, { Location: "/login" });
      res.end();
      return;
    }
    const isSecure = config.EXTERNAL_URL.startsWith("https://");
    const clearSessionCookie = `yeti_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${isSecure ? "; Secure" : ""}`;
    const clearTokenCookie = `yeti_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${isSecure ? "; Secure" : ""}`;
    res.writeHead(302, { Location: "/login", "Set-Cookie": [clearSessionCookie, clearTokenCookie] });
    res.end();
    return;
  }

  if (req.url === "/status") {
    if (!requireAuth(req, res)) return;
    const uptimeMs = Date.now() - new Date(startedAt).getTime();
    const jobs: Record<string, boolean> = {};
    for (const [name, running] of scheduler.jobStates()) {
      jobs[name] = running;
    }
    const cq = queueStatus();
    const cpq = copilotQueueStatus();
    const cxq = codexQueueStatus();
    const runningTasks = getRunningTasks().map(t => ({
      jobName: t.job_name,
      repo: t.repo,
      itemNumber: t.item_number,
      startedAt: t.started_at,
    }));
    const latestRuns = getLatestRunIdsByJob();
    const schedInfo = scheduler.jobScheduleInfo();
    const pausedSet = scheduler.pausedJobs();
    const jobSchedules: Record<string, { intervalMs?: number; scheduledHour?: number; lastCompletedAt: string | null; nextRunIn: number | null }> = {};
    for (const [name] of scheduler.jobStates()) {
      const sched = schedInfo.get(name);
      const latest = latestRuns.get(name);
      const lastCompletedAt = latest?.completedAt ? latest.completedAt + "Z" : null;
      let nextRunIn: number | null = null;
      if (!pausedSet.has(name) && sched) {
        if (sched.scheduledHour !== undefined) {
          nextRunIn = msUntilHour(sched.scheduledHour);
        } else if (latest?.startedAt) {
          nextRunIn = Math.max(0, new Date(latest.startedAt + "Z").getTime() + sched.intervalMs - Date.now());
        } else {
          nextRunIn = sched.intervalMs;
        }
      }
      jobSchedules[name] = {
        ...(sched?.scheduledHour !== undefined ? { scheduledHour: sched.scheduledHour } : { intervalMs: sched?.intervalMs }),
        lastCompletedAt,
        nextRunIn,
      };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
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
      }),
    );
    return;
  }

  if (req.url === "/") {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const uptimeMs = Date.now() - new Date(startedAt).getTime();
    const jobs: Record<string, boolean> = {};
    for (const [name, running] of scheduler.jobStates()) {
      jobs[name] = running;
    }
    const runningTasks = getRunningTasks().map(t => ({
      jobName: t.job_name,
      repo: t.repo,
      itemNumber: t.item_number,
      startedAt: t.started_at,
    }));
    const latestRuns = getLatestRunIdsByJob();
    const paused = scheduler.pausedJobs();
    const schedInfo = scheduler.jobScheduleInfo();
    const html = buildStatusPage(
      VERSION,
      Math.floor(uptimeMs / 1000),
      jobs,
      queueStatus(),
      discordStatus(),
      runningTasks,
      latestRuns,
      theme,
      startedAt,
      paused,
      schedInfo,
      copilotQueueStatus(),
      codexQueueStatus(),
      auth.username,
    );
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }

  if (req.url === "/repos") {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const ALL_CATEGORIES: QueueCategory[] = ["ready", "needs-refinement", "refined", "needs-review-addressing", "auto-mergeable", "needs-triage", "needs-plan-review"];
    const repos = await listRepos();
    const allOrgRepos = await listAllOrgRepos();
    const snapshot = getQueueSnapshot(ALL_CATEGORIES);
    await enrichQueueItemsWithPRStatus(snapshot.items);
    const recentTasks = getRecentCompletedTasks(50);
    const configuredNames = new Set(repos.map(r => r.name.toLowerCase()));
    const availableRepos = allOrgRepos.filter(r => !configuredNames.has(r.name.toLowerCase()));
    const html = buildReposPage({
      repos,
      queueItems: snapshot.items,
      recentTasks,
      availableRepos,
      allowedReposIsNull: config.ALLOWED_REPOS === null,
      theme,
      username: auth.username,
    });
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }

  if (req.url === "/jobs") {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const jobs: Record<string, boolean> = {};
    for (const [name, running] of scheduler.jobStates()) {
      jobs[name] = running;
    }
    const latestRuns = getLatestRunIdsByJob();
    const paused = scheduler.pausedJobs();
    const schedInfo = scheduler.jobScheduleInfo();
    const enabledSet = new Set(config.ENABLED_JOBS);
    const html = buildJobsPage(
      allJobs, enabledSet, config.JOB_AI,
      jobs, latestRuns, theme, paused, schedInfo,
      auth.username,
    );
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }

  if (req.url === "/config" || req.url?.startsWith("/config?")) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const urlObj = new URL(req.url, "http://localhost");
    const saved = urlObj.searchParams.get("saved") === "1";
    res.writeHead(200, { "Content-Type": "text/html" });
    const tabParam = urlObj.searchParams.get("tab") ?? undefined;
    res.end(buildConfigPage(saved, theme, auth.username, tabParam));
    return;
  }

  if (req.url === "/config/api") {
    if (!requireAuth(req, res)) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(getConfigForDisplay()));
    return;
  }

  // GET /logs or GET /logs?job=... or GET /logs?search=...
  if (req.url === "/logs" || req.url?.startsWith("/logs?")) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const urlObj = new URL(req.url, `http://localhost`);
    const jobFilter = urlObj.searchParams.get("job");
    const search = urlObj.searchParams.get("search") ?? undefined;
    const runs = search
      ? searchRunsByItem(search)
      : getRecentJobRuns(50, jobFilter ?? undefined);
    const jobNames = getDistinctJobNames();
    const workItems = getWorkItemsForRuns(runs.map((r) => r.run_id));
    const recentItems = search ? [] : getRecentWorkItems();
    const html = buildLogsListPage(runs, jobNames, jobFilter, theme, workItems, search, recentItems, auth.username);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }

  // GET /logs/issue?repo=...&number=...
  if (req.url?.startsWith("/logs/issue?") || req.url === "/logs/issue") {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const urlObj = new URL(req.url, "http://localhost");
    const repoParam = urlObj.searchParams.get("repo");
    const numberParam = urlObj.searchParams.get("number");
    const num = parseInt(numberParam ?? "", 10);
    if (!repoParam || !numberParam || !Number.isFinite(num) || num < 1) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Missing or invalid repo/number query params");
      return;
    }
    const runs = getRunsForIssue(repoParam, num);
    const runIds = runs.map(r => r.run_id);
    const logsByRun = getLogsForRuns(runIds);
    const workItems = getWorkItemsForRuns(runIds);
    const html = buildIssueLogsPage(repoParam, num, runs, logsByRun, workItems, theme, auth.username);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }

  // GET /logs/:runId/tail?after=N
  if (req.url?.startsWith("/logs/") && req.url.includes("/tail")) {
    if (!requireAuth(req, res)) return;
    const urlObj = new URL(req.url, "http://localhost");
    const pathParts = urlObj.pathname.split("/");
    // /logs/:runId/tail → ["", "logs", runId, "tail"]
    const runId = decodeURIComponent(pathParts[2]);
    const afterId = parseInt(urlObj.searchParams.get("after") ?? "0", 10) || 0;
    const run = getJobRun(runId);
    if (!run) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Run not found" }));
      return;
    }
    const logs = getJobRunLogsSince(runId, afterId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: run.status,
      completed_at: run.completed_at,
      logs: logs.map(l => ({ id: l.id, level: l.level, message: l.message, logged_at: l.logged_at })),
    }));
    return;
  }

  // GET /logs/:runId
  if (req.url?.startsWith("/logs/")) {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const runId = decodeURIComponent(req.url.slice("/logs/".length));
    const run = getJobRun(runId);
    if (!run) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Run not found");
      return;
    }
    const logs = getJobRunLogs(runId);
    const tasks = getTasksByRunId(runId);
    const html = buildLogDetailPage(run, logs, theme, tasks, auth.username);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }

  if (req.url === "/queue") {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const myAttention = getQueueSnapshot(MY_ATTENTION_CATEGORIES);
    const yetiAttention = getQueueSnapshot(YETI_ATTENTION_CATEGORIES);
    await enrichQueueItemsWithPRStatus(myAttention.items);
    const html = buildQueuePage(myAttention, yetiAttention, theme, config.SKIPPED_ITEMS as Array<{ repo: string; number: number }>, auth.username);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
    return;
  }

  res.writeHead(404).end();
}
