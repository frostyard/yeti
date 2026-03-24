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
  const params = new URLSearchParams({
    client_id: GITHUB_APP_CLIENT_ID,
    redirect_uri: `${EXTERNAL_URL}/auth/callback`,
    state,
    scope: "read:org",
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

  // Step 3: Check org membership via user's own org list.
  // GET /user/orgs lists the authenticated user's orgs (requires read:org scope).
  // This avoids the circular permission issue with GET /orgs/{org}/members/{username},
  // which requires the requester to already be an org member.
  const allowedOwners = new Set(GITHUB_OWNERS.map(o => o.toLowerCase()));
  try {
    const orgsRes = await fetch("https://api.github.com/user/orgs?per_page=100", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (!orgsRes.ok) {
      log.warn(`OAuth org list fetch failed: HTTP ${orgsRes.status}`);
      return null; // Transient error — don't blame the user
    }
    const orgs = (await orgsRes.json()) as Array<{ login?: string }>;
    for (const org of orgs) {
      if (org.login && allowedOwners.has(org.login.toLowerCase())) {
        return { login };
      }
    }
  } catch (err) {
    log.warn(`OAuth org list fetch failed: ${err}`);
    return null; // Transient error — don't blame the user
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
