import http from "node:http";
import crypto from "node:crypto";
import { SERVER_PORT } from "./config.js";
import * as config from "./config.js";
import { getNotificationsSince } from "./db.js";
import * as log from "./log.js";
import type { Scheduler } from "./scheduler.js";
import { VERSION } from "./version.js";
import { type JobInfo } from "./job-meta.js";
import { isOAuthConfigured, getAuthorizationUrl, exchangeCodeForUser, createSessionCookie } from "./oauth.js";
import { verifyWebhookSignature, handleWebhookEvent } from "./webhooks.js";
import { notificationEmitter } from "./notify.js";
import { parseCookies, readRawBody, requireApiAuth } from "./http-util.js";
import { handleApi } from "./api.js";
import { staticServer } from "./static.js";

// Re-export for backwards compatibility with tests and other consumers.
export { formatUptime, formatRelativeTime } from "./format.js";

const startedAt = new Date().toISOString();

const sseClients = new Set<{ res: http.ServerResponse; keepalive: ReturnType<typeof setInterval> }>();
let sseNotificationListener: ((...args: unknown[]) => void) | null = null;

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

  // Remove any previous listener (e.g. from a prior createServer call in tests).
  if (sseNotificationListener) {
    notificationEmitter.removeListener("notification", sseNotificationListener);
  }
  sseNotificationListener = (row: unknown) => {
    const r = row as { id: number; job_name: string; message: string; url: string | null; level: string; created_at: string };
    const payload = JSON.stringify({
      id: r.id, jobName: r.job_name, message: r.message, url: r.url, level: r.level, createdAt: r.created_at,
    });
    for (const client of sseClients) {
      client.res.write(`id: ${r.id}\ndata: ${payload}\n\n`);
    }
  };
  notificationEmitter.on("notification", sseNotificationListener);

  server.listen(SERVER_PORT, () => {
    log.info(`HTTP server listening on port ${SERVER_PORT}`);
  });

  return server;
}

export function closeSSEConnections(): void {
  for (const client of sseClients) {
    clearInterval(client.keepalive);
    client.res.end();
  }
  sseClients.clear();
  if (sseNotificationListener) {
    notificationEmitter.removeListener("notification", sseNotificationListener);
    sseNotificationListener = null;
  }
}

/** Open a Server-Sent Events stream for notifications, registering the client. */
function startNotificationStream(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const lastId = req.headers["last-event-id"];
  const afterId = lastId ? Number(lastId) : NaN;
  if (!isNaN(afterId)) {
    for (const row of getNotificationsSince(afterId)) {
      const payload = JSON.stringify({
        id: row.id, jobName: row.job_name, message: row.message,
        url: row.url, level: row.level, createdAt: row.created_at,
      });
      res.write(`id: ${row.id}\ndata: ${payload}\n\n`);
    }
  }

  const keepalive = setInterval(() => res.write(`: keepalive\n\n`), 30_000);
  const client = { res, keepalive };
  sseClients.add(client);
  req.on("close", () => {
    clearInterval(keepalive);
    sseClients.delete(client);
  });
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, scheduler: Scheduler, allJobs: JobInfo[]): Promise<void> {
  // ── Webhook endpoint — HMAC auth only, no OAuth/token required ──
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

  // ── Notification SSE stream (kept here for access to the sseClients registry) ──
  if (req.method === "GET" && req.url === "/api/notifications/stream") {
    if (!requireApiAuth(req, res)) return;
    startNotificationStream(req, res);
    return;
  }

  // ── JSON API namespace (handles its own auth + methods) ──
  if (req.url?.startsWith("/api/")) {
    await handleApi(req, res, scheduler, allJobs, startedAt);
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405).end();
    return;
  }

  // ── GET: health ──
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", version: VERSION }));
    return;
  }

  // ── OAuth routes (server-side redirects) ──
  if (req.url === "/auth/github") {
    if (!isOAuthConfigured()) {
      res.writeHead(302, { Location: "/login" });
      res.end();
      return;
    }
    const state = crypto.randomBytes(20).toString("hex");
    const isSecure = config.EXTERNAL_URL.startsWith("https://");
    const stateCookie = `yeti_oauth_state=${state}; HttpOnly; SameSite=Lax; Path=/auth/callback; Max-Age=300${isSecure ? "; Secure" : ""}`;
    res.writeHead(302, { Location: getAuthorizationUrl(state), "Set-Cookie": stateCookie });
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

    const cookieState = parseCookies(req.headers.cookie)["yeti_oauth_state"];
    if (!cookieState || !state || cookieState !== state) {
      res.writeHead(302, { Location: "/login?error=oauth_error", "Set-Cookie": clearStateCookie });
      res.end();
      return;
    }

    const result = await exchangeCodeForUser(code);
    if (!result || "error" in result) {
      const errorType = result && "error" in result && result.error === "not_org_member" ? "not_org_member" : "oauth_error";
      res.writeHead(302, { Location: `/login?error=${errorType}`, "Set-Cookie": clearStateCookie });
      res.end();
      return;
    }

    const sessionValue = createSessionCookie(result.login);
    const sessionCookie = `yeti_session=${sessionValue}; HttpOnly; SameSite=Strict; Path=/${isSecure ? "; Secure" : ""}; Max-Age=86400`;
    res.writeHead(302, { Location: "/", "Set-Cookie": [clearStateCookie, sessionCookie] });
    res.end();
    return;
  }

  if (req.url === "/auth/logout") {
    const isSecure = config.EXTERNAL_URL.startsWith("https://");
    const clearSessionCookie = `yeti_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${isSecure ? "; Secure" : ""}`;
    const clearTokenCookie = `yeti_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${isSecure ? "; Secure" : ""}`;
    res.writeHead(302, { Location: "/login", "Set-Cookie": [clearSessionCookie, clearTokenCookie] });
    res.end();
    return;
  }

  // ── Built SPA static assets + client-side routing fallback ──
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  if (staticServer.serve(req, res, pathname)) return;

  res.writeHead(404).end();
}
