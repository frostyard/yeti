import http from "node:http";
import crypto from "node:crypto";
import * as config from "./config.js";
import { isOAuthConfigured, verifySessionCookie } from "./oauth.js";

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return cookies;
}

export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function readBody(req: http.IncomingMessage, maxBytes = 1024 * 1024): Promise<string> {
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

export function readRawBody(req: http.IncomingMessage, maxBytes = 1024 * 1024): Promise<Buffer> {
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

export function parseFormBody(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of body.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    params[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
  }
  return params;
}

export function isAuthEnabled(): boolean {
  return !!(config.AUTH_TOKEN || isOAuthConfigured());
}

/**
 * Resolve the caller's session without any response side effects.
 * Returns `{ username }` when authorized (username is null for token auth, or
 * the GitHub login for OAuth), or `null` when auth is enabled but no valid
 * credentials were supplied. When auth is disabled entirely, returns `{ username: null }`.
 */
export function getSession(req: http.IncomingMessage): { username: string | null } | null {
  if (!isAuthEnabled()) return { username: null };

  const token = config.AUTH_TOKEN;
  if (token) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ") && safeCompare(authHeader.slice(7), token)) {
      return { username: null };
    }
    const cookieToken = parseCookies(req.headers.cookie)["yeti_token"];
    if (cookieToken && safeCompare(cookieToken, token)) return { username: null };
  }

  if (isOAuthConfigured()) {
    const sessionCookie = parseCookies(req.headers.cookie)["yeti_session"];
    if (sessionCookie) {
      const session = verifySessionCookie(sessionCookie);
      if (session) return { username: session.login };
    }
  }

  return null;
}

/** Returns the session if authorized, or false after sending a JSON 401. */
export function requireApiAuth(req: http.IncomingMessage, res: http.ServerResponse): false | { username: string | null } {
  const session = getSession(req);
  if (session) return session;
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "unauthorized" }));
  return false;
}

/** Send a JSON response with the given status code. */
export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
