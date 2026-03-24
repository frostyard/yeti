import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./config.js", () => ({
  GITHUB_APP_CLIENT_ID: "test-client-id",
  GITHUB_APP_CLIENT_SECRET: "test-client-secret",
  EXTERNAL_URL: "https://yeti.example.com",
  GITHUB_OWNERS: ["test-org", "personal-user"],
}));

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import {
  isOAuthConfigured,
  getAuthorizationUrl,
  exchangeCodeForUser,
  createSessionCookie,
  verifySessionCookie,
} from "./oauth.js";

describe("isOAuthConfigured", () => {
  it("returns true when all three fields are set", () => {
    expect(isOAuthConfigured()).toBe(true);
  });

  it("returns false when client ID is empty", async () => {
    const configMod = await import("./config.js");
    const original = configMod.GITHUB_APP_CLIENT_ID;
    (configMod as Record<string, unknown>).GITHUB_APP_CLIENT_ID = "";
    expect(isOAuthConfigured()).toBe(false);
    (configMod as Record<string, unknown>).GITHUB_APP_CLIENT_ID = original;
  });

  it("returns false when client secret is empty", async () => {
    const configMod = await import("./config.js");
    const original = configMod.GITHUB_APP_CLIENT_SECRET;
    (configMod as Record<string, unknown>).GITHUB_APP_CLIENT_SECRET = "";
    expect(isOAuthConfigured()).toBe(false);
    (configMod as Record<string, unknown>).GITHUB_APP_CLIENT_SECRET = original;
  });

  it("returns false when external URL is empty", async () => {
    const configMod = await import("./config.js");
    const original = configMod.EXTERNAL_URL;
    (configMod as Record<string, unknown>).EXTERNAL_URL = "";
    expect(isOAuthConfigured()).toBe(false);
    (configMod as Record<string, unknown>).EXTERNAL_URL = original;
  });
});

describe("getAuthorizationUrl", () => {
  it("builds correct GitHub authorize URL with read:org scope", () => {
    const url = getAuthorizationUrl("random-state-123");
    expect(url).toContain("https://github.com/login/oauth/authorize?");
    expect(url).toContain("client_id=test-client-id");
    expect(url).toContain("redirect_uri=https%3A%2F%2Fyeti.example.com%2Fauth%2Fcallback");
    expect(url).toContain("state=random-state-123");
    expect(url).toContain("scope=read%3Aorg");
  });
});

describe("exchangeCodeForUser", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("exchanges code for token, gets user, checks org membership", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: "ghu_test_token" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ login: "testuser" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([{ login: "test-org" }, { login: "other-org" }]),
        }),
    );

    const result = await exchangeCodeForUser("test-code");
    expect(result).toEqual({ login: "testuser" });

    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Token exchange
    expect(fetchMock.mock.calls[0][0]).toBe("https://github.com/login/oauth/access_token");
    // User identity
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.github.com/user");
    // Org list
    expect(fetchMock.mock.calls[2][0]).toBe("https://api.github.com/user/orgs?per_page=100");
  });

  it("returns null when token exchange fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
      }),
    );

    const result = await exchangeCodeForUser("bad-code");
    expect(result).toBeNull();
  });

  it("returns null when token exchange returns error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ error: "bad_verification_code" }),
      }),
    );

    const result = await exchangeCodeForUser("expired-code");
    expect(result).toBeNull();
  });

  it("returns null when user identity fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: "ghu_test" }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 401,
        }),
    );

    const result = await exchangeCodeForUser("test-code");
    expect(result).toBeNull();
  });

  it("returns not_org_member error when user is not a member of any configured org", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: "ghu_test" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ login: "outsider" }),
        })
        // User's orgs don't include any configured owner
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([{ login: "unrelated-org" }]),
        }),
    );

    const result = await exchangeCodeForUser("test-code");
    expect(result).toEqual({ error: "not_org_member" });
  });

  it("returns not_org_member when user has no orgs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: "ghu_test" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ login: "testuser" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([]),
        }),
    );

    const result = await exchangeCodeForUser("test-code");
    expect(result).toEqual({ error: "not_org_member" });
  });

  it("matches org names case-insensitively", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: "ghu_test" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ login: "testuser" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([{ login: "Test-Org" }]),
        }),
    );

    const result = await exchangeCodeForUser("test-code");
    expect(result).toEqual({ login: "testuser" });
  });

  it("returns null on transient error fetching org list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: "ghu_test" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ login: "testuser" }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
        }),
    );

    const result = await exchangeCodeForUser("test-code");
    expect(result).toBeNull();
  });

  it("handles network error gracefully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValueOnce(new Error("network error")),
    );

    const result = await exchangeCodeForUser("test-code");
    expect(result).toBeNull();
  });
});

describe("session cookies", () => {
  it("createSessionCookie produces a valid cookie that verifySessionCookie accepts", () => {
    const cookie = createSessionCookie("testuser");
    const result = verifySessionCookie(cookie);
    expect(result).toEqual({ login: "testuser" });
  });

  it("verifySessionCookie returns null for tampered payload", () => {
    const cookie = createSessionCookie("testuser");
    const parts = cookie.split(".");
    // Tamper with the payload
    const tampered = Buffer.from(JSON.stringify({ login: "hacker", exp: 9999999999 })).toString("base64url");
    const result = verifySessionCookie(`${tampered}.${parts[1]}`);
    expect(result).toBeNull();
  });

  it("verifySessionCookie returns null for expired cookie", async () => {
    // Create a cookie with an expired timestamp manually
    const crypto = await import("node:crypto");
    const configMod = await import("./config.js");
    const payload = JSON.stringify({
      login: "testuser",
      exp: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
    });
    const payloadB64 = Buffer.from(payload).toString("base64url");
    const key = crypto
      .createHmac("sha256", configMod.GITHUB_APP_CLIENT_SECRET)
      .update("yeti-session-key")
      .digest();
    const hmac = crypto.createHmac("sha256", key).update(payloadB64).digest("base64url");
    const cookie = `${payloadB64}.${hmac}`;

    const result = verifySessionCookie(cookie);
    expect(result).toBeNull();
  });

  it("verifySessionCookie returns null for malformed cookie (no dot)", () => {
    const result = verifySessionCookie("nodothere");
    expect(result).toBeNull();
  });

  it("verifySessionCookie returns null for malformed payload", () => {
    const result = verifySessionCookie("notbase64.fakesignature");
    expect(result).toBeNull();
  });

  it("verifySessionCookie returns null for empty string", () => {
    const result = verifySessionCookie("");
    expect(result).toBeNull();
  });
});
