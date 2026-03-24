import crypto from "node:crypto";
import { GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, EXTERNAL_URL, GITHUB_OWNERS } from "./config.js";
import * as log from "./log.js";

const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

function getSessionKey(): Buffer {
  return crypto
    .createHmac("sha256", GITHUB_APP_CLIENT_SECRET)
    .update("yeti-session-key")
    .digest();
}

export function isOAuthConfigured(): boolean {
  return !!(GITHUB_APP_CLIENT_ID && GITHUB_APP_CLIENT_SECRET && EXTERNAL_URL);
}

export function getAuthorizationUrl(state: string): string {
  // Note: GitHub App OAuth ignores the scope parameter — permissions come from the
  // App's configured permissions. We omit scope intentionally.
  const params = new URLSearchParams({
    client_id: GITHUB_APP_CLIENT_ID,
    redirect_uri: `${EXTERNAL_URL}/auth/callback`,
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

export type OAuthResult = { login: string } | { error: "not_org_member" } | null;

export async function exchangeCodeForUser(code: string): Promise<OAuthResult> {
  // Step 1: Exchange code for access token
  let accessToken: string;
  try {
    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: GITHUB_APP_CLIENT_ID,
        client_secret: GITHUB_APP_CLIENT_SECRET,
        code,
      }),
    });
    if (!tokenRes.ok) {
      log.warn(`OAuth token exchange failed: HTTP ${tokenRes.status}`);
      return null;
    }
    const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
    if (tokenData.error || !tokenData.access_token) {
      log.warn(`OAuth token exchange error: ${tokenData.error ?? "no access_token"}`);
      return null;
    }
    accessToken = tokenData.access_token;
  } catch (err) {
    log.warn(`OAuth token exchange network error: ${err}`);
    return null;
  }

  // Step 2: Fetch user identity
  let login: string;
  try {
    const userRes = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!userRes.ok) {
      log.warn(`OAuth user identity fetch failed: HTTP ${userRes.status}`);
      return null;
    }
    const scopes = userRes.headers.get("x-oauth-scopes") ?? "(none)";
    log.info(`[oauth] Token scopes: ${scopes}`);
    const userData = (await userRes.json()) as { login?: string };
    if (!userData.login) {
      log.warn("OAuth user identity missing login field");
      return null;
    }
    login = userData.login;
  } catch (err) {
    log.warn(`OAuth user identity network error: ${err}`);
    return null;
  }

  // Step 3: Check org membership using the installation token.
  // GitHub App user OAuth tokens don't support scopes — permissions come from the
  // App config. Using the installation token (which has Organization > Members: Read)
  // avoids this limitation. GET /orgs/{org}/members/{username} returns 204 if member.
  const installationToken = process.env["GH_TOKEN"];
  if (!installationToken) {
    log.warn("[oauth] No installation token available for org membership check");
    return null;
  }

  for (const owner of GITHUB_OWNERS) {
    try {
      const memberRes = await fetch(
        `https://api.github.com/orgs/${encodeURIComponent(owner)}/members/${encodeURIComponent(login)}`,
        {
          headers: {
            Authorization: `Bearer ${installationToken}`,
            Accept: "application/json",
          },
        },
      );
      log.info(`[oauth] Org check ${owner}/${login}: HTTP ${memberRes.status}`);
      if (memberRes.status === 204) {
        return { login };
      }
      // 404 = not a member or not an org — try next owner
      if (memberRes.status !== 404) {
        log.warn(`[oauth] Unexpected status ${memberRes.status} checking ${owner} membership`);
        return null; // Transient/permission error — don't blame the user
      }
    } catch (err) {
      log.warn(`[oauth] Org check for ${owner} failed: ${err}`);
      return null; // Transient error
    }
  }

  log.warn(`OAuth user ${login} is not a member of any configured org (${GITHUB_OWNERS.join(", ")})`);
  return { error: "not_org_member" };
}

export function createSessionCookie(login: string): string {
  const payload = JSON.stringify({
    login,
    exp: Math.floor((Date.now() + SESSION_EXPIRY_MS) / 1000),
  });
  const payloadB64 = Buffer.from(payload).toString("base64url");
  const hmac = crypto
    .createHmac("sha256", getSessionKey())
    .update(payloadB64)
    .digest("base64url");
  return `${payloadB64}.${hmac}`;
}

export function verifySessionCookie(cookie: string): { login: string } | null {
  const dotIndex = cookie.indexOf(".");
  if (dotIndex < 0) return null;

  const payloadB64 = cookie.slice(0, dotIndex);
  const providedHmac = cookie.slice(dotIndex + 1);

  const expectedHmac = crypto
    .createHmac("sha256", getSessionKey())
    .update(payloadB64)
    .digest("base64url");

  // Timing-safe compare
  const a = Buffer.from(providedHmac);
  const b = Buffer.from(expectedHmac);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf-8")) as {
      login?: string;
      exp?: number;
    };
    if (!payload.login || typeof payload.exp !== "number") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return { login: payload.login };
  } catch {
    return null;
  }
}
