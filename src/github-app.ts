import crypto from "node:crypto";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY_PATH } from "./config.js";
import { setSelfLogin, setGhPreCallHook } from "./github.js";
import { setGitPreCallHook } from "./claude.js";
import * as log from "./log.js";

// ── State ──

let cachedToken = "";
let tokenExpiresAt = 0; // epoch ms
let appSlug: string | null = null;
let inflightRefresh: Promise<void> | null = null;

/** Reset module state for testing. */
export function _resetForTests(): void {
  cachedToken = "";
  tokenExpiresAt = 0;
  appSlug = null;
  inflightRefresh = null;
}

// ── Public API ──

/** Whether all three GitHub App config values are set. */
export function isGitHubAppConfigured(): boolean {
  return !!(GITHUB_APP_ID && GITHUB_APP_INSTALLATION_ID && GITHUB_APP_PRIVATE_KEY_PATH);
}

/**
 * Initialize GitHub App authentication.
 * Sets process.env.GH_TOKEN and configures git credential helper.
 * Must be called before the scheduler starts.
 */
export async function initGitHubApp(): Promise<void> {
  if (!isGitHubAppConfigured()) return;

  // Validate private key file
  const keyPath = GITHUB_APP_PRIVATE_KEY_PATH;
  if (!fs.existsSync(keyPath)) {
    throw new Error(`GitHub App private key not found: ${keyPath}`);
  }

  // Check permissions (warn if not 0600)
  const stats = fs.statSync(keyPath);
  const mode = stats.mode & 0o777;
  if (mode !== 0o600) {
    log.warn(`[github-app] Private key file ${keyPath} has permissions ${mode.toString(8)}, expected 600`);
  }

  // Capture pre-init state so we can restore on any failure
  const previousToken = process.env["GH_TOKEN"];

  try {
    // Get first installation token (sets process.env.GH_TOKEN)
    await refreshToken();

    // App slug is required — without it we can't set the bot login, and
    // getSelfLogin() will fall back to GET /user which fails with installation tokens.
    if (!appSlug) {
      throw new Error("GitHub App init failed: could not determine app slug from GET /app");
    }

    // Configure git credential helper — must succeed before we apply side effects
    await exec("gh", ["auth", "setup-git"]);
  } catch (err) {
    rollback(previousToken);
    throw err;
  }

  // All fallible steps done — now apply side effects that won't throw

  setSelfLogin(`${appSlug}[bot]`);
  log.info(`[github-app] Bot identity: ${appSlug}[bot]`);

  // Register pre-call hooks so every gh()/git() call refreshes the token if needed
  const refreshHook = () => ensureGitHubAppToken();
  setGhPreCallHook(refreshHook);
  setGitPreCallHook(refreshHook);

  log.info(`[github-app] Token expires at ${new Date(tokenExpiresAt).toISOString()}`);
}

/**
 * Ensure the installation token is still valid (with 5-min buffer).
 * Cheap no-op when the token is fresh. Dedupes concurrent callers.
 */
export async function ensureGitHubAppToken(): Promise<void> {
  if (!isGitHubAppConfigured()) return;
  if (Date.now() < tokenExpiresAt - 5 * 60 * 1000) return;

  if (inflightRefresh) {
    await inflightRefresh;
    return;
  }

  inflightRefresh = refreshToken().finally(() => {
    inflightRefresh = null;
  });
  await inflightRefresh;
}

/** Returns the App's slug (e.g., "yeti") or null if not configured. */
export function getAppSlug(): string | null {
  return appSlug;
}

// ── Internal ──

/** Restore process to pre-init state so personal auth continues to work. */
function rollback(previousToken: string | undefined): void {
  if (previousToken !== undefined) {
    process.env["GH_TOKEN"] = previousToken;
  } else {
    delete process.env["GH_TOKEN"];
  }
  cachedToken = "";
  tokenExpiresAt = 0;
  appSlug = null;
}

/** Generate a JWT signed with the App's private key (RS256). */
export function generateJWT(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: Number(GITHUB_APP_ID), // GitHub requires iss to be numeric, not a string
    iat: now - 30, // 30s backdate for clock drift
    exp: now + 10 * 60, // 10 min
  };

  const segments = [
    base64url(JSON.stringify(header)),
    base64url(JSON.stringify(payload)),
  ];

  const privateKey = fs.readFileSync(GITHUB_APP_PRIVATE_KEY_PATH, "utf-8");
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(segments.join("."));
  const signature = signer.sign(privateKey, "base64url");

  return `${segments.join(".")}.${signature}`;
}

async function refreshToken(): Promise<void> {
  const jwt = generateJWT();

  // GitHub App endpoints require "Authorization: Bearer <jwt>", but the gh CLI
  // sends GH_TOKEN as "Authorization: token <value>". So we use fetch() directly
  // for the JWT-authenticated bootstrap calls.

  try {
    // GET /app requires JWT — fetch slug on first call
    if (!appSlug) {
      try {
        const appInfo = await githubApi<{ slug?: string }>("GET", "/app", jwt);
        appSlug = appInfo.slug ?? null;
      } catch {
        // Swallowed here; initGitHubApp() checks appSlug and fails if null
      }
    }

    const response = await githubApi<{ token: string; expires_at: string }>(
      "POST",
      `/app/installations/${GITHUB_APP_INSTALLATION_ID}/access_tokens`,
      jwt,
    );
    cachedToken = response.token;
    tokenExpiresAt = new Date(response.expires_at).getTime();
    process.env["GH_TOKEN"] = cachedToken;
  } catch (err) {
    // Ensure GH_TOKEN is not left in a bad state
    if (cachedToken) {
      process.env["GH_TOKEN"] = cachedToken; // keep last good token if we had one
    } else {
      delete process.env["GH_TOKEN"];
    }
    throw err;
  }
}

/** Direct GitHub API call with Bearer auth (for JWT-authenticated endpoints). */
async function githubApi<T>(method: string, path: string, token: string): Promise<T> {
  const url = `https://api.github.com${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${method} ${path} failed (${res.status}): ${body}`);
  }
  return await res.json() as T;
}

function base64url(input: string): string {
  return Buffer.from(input).toString("base64url");
}

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr || err.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}
