import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

// ── Mocks ──

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./github.js", () => ({
  setSelfLogin: vi.fn(),
  setGhPreCallHook: vi.fn(),
}));

vi.mock("./claude.js", () => ({
  setGitPreCallHook: vi.fn(),
}));

const mockConfig = {
  appId: "",
  installationId: "",
  keyPath: "",
};

vi.mock("./config.js", () => ({
  get GITHUB_APP_ID() { return mockConfig.appId; },
  get GITHUB_APP_INSTALLATION_ID() { return mockConfig.installationId; },
  get GITHUB_APP_PRIVATE_KEY_PATH() { return mockConfig.keyPath; },
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(),
      statSync: vi.fn(),
      readFileSync: vi.fn(),
    },
  };
});

import { execFile } from "node:child_process";
import fs from "node:fs";
import * as log from "./log.js";
import { isGitHubAppConfigured, generateJWT, initGitHubApp, ensureGitHubAppToken, getAppSlug, _resetForTests } from "./github-app.js";

const mockExecFile = vi.mocked(execFile);
const mockFs = vi.mocked(fs);

// Generate a test RSA key pair (once, shared across tests)
const { privateKey: testPrivateKey, publicKey: testPublicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

/** Helper: configure mockExecFile to handle typical init flow */
function setupExecMock(tokenOverrides?: { token?: string; expires_at?: string }) {
  const token = tokenOverrides?.token ?? "ghs_test123";
  const expiresAt = tokenOverrides?.expires_at ?? new Date(Date.now() + 3600000).toISOString();

  mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
    const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
    const argsArr = args as string[];
    if (argsArr.some(a => a.includes("access_tokens"))) {
      callback(null, JSON.stringify({ token, expires_at: expiresAt }), "");
    } else if (argsArr.some(a => a === "/app")) {
      callback(null, JSON.stringify({ slug: "yeti" }), "");
    } else {
      callback(null, "", "");
    }
    return undefined as never;
  });
}

beforeEach(() => {
  mockConfig.appId = "12345";
  mockConfig.installationId = "67890";
  mockConfig.keyPath = "/home/yeti/.yeti/app.pem";

  mockFs.existsSync.mockReturnValue(true);
  mockFs.statSync.mockReturnValue({ mode: 0o100600 } as ReturnType<typeof fs.statSync>);
  mockFs.readFileSync.mockReturnValue(testPrivateKey);

  delete process.env["GH_TOKEN"];
  _resetForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env["GH_TOKEN"];
});

describe("isGitHubAppConfigured", () => {
  it("returns true when all three config values are set", () => {
    expect(isGitHubAppConfigured()).toBe(true);
  });

  it("returns false when appId is empty", () => {
    mockConfig.appId = "";
    expect(isGitHubAppConfigured()).toBe(false);
  });

  it("returns false when installationId is empty", () => {
    mockConfig.installationId = "";
    expect(isGitHubAppConfigured()).toBe(false);
  });

  it("returns false when keyPath is empty", () => {
    mockConfig.keyPath = "";
    expect(isGitHubAppConfigured()).toBe(false);
  });
});

describe("generateJWT", () => {
  it("produces a valid 3-part JWT with RS256 header", () => {
    const jwt = generateJWT();
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);

    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
  });

  it("sets correct claims (iss, iat, exp)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-24T12:00:00Z"));

    const jwt = generateJWT();
    const parts = jwt.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());

    const now = Math.floor(Date.now() / 1000);
    expect(payload.iss).toBe("12345");
    expect(payload.iat).toBe(now - 30);
    expect(payload.exp).toBe(now + 600);

    vi.useRealTimers();
  });

  it("signature is verifiable with the public key", () => {
    const jwt = generateJWT();
    const [headerB64, payloadB64, signatureB64] = jwt.split(".");

    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(`${headerB64}.${payloadB64}`);
    const isValid = verifier.verify(testPublicKey, signatureB64, "base64url");
    expect(isValid).toBe(true);
  });
});

describe("initGitHubApp", () => {
  it("throws if private key file does not exist", async () => {
    mockFs.existsSync.mockReturnValue(false);
    await expect(initGitHubApp()).rejects.toThrow("private key not found");
  });

  it("warns if PEM file permissions are not 0600", async () => {
    mockFs.statSync.mockReturnValue({ mode: 0o100644 } as ReturnType<typeof fs.statSync>);
    setupExecMock();

    await initGitHubApp();

    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
      expect.stringContaining("permissions"),
    );
  });

  it("sets process.env.GH_TOKEN to the installation token", async () => {
    setupExecMock({ token: "ghs_installation_token" });

    await initGitHubApp();

    expect(process.env["GH_TOKEN"]).toBe("ghs_installation_token");
  });

  it("runs gh auth setup-git after obtaining token", async () => {
    const calls: string[][] = [];
    mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
      const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
      const argsArr = args as string[];
      calls.push(argsArr);
      if (argsArr.some(a => a.includes("access_tokens"))) {
        callback(null, JSON.stringify({
          token: "ghs_test",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        }), "");
      } else if (argsArr.some(a => a === "/app")) {
        callback(null, JSON.stringify({ slug: "yeti" }), "");
      } else {
        callback(null, "", "");
      }
      return undefined as never;
    });

    await initGitHubApp();

    expect(calls.some(c => c.includes("setup-git"))).toBe(true);
  });

  it("is a no-op when not configured", async () => {
    mockConfig.appId = "";
    await initGitHubApp();
    expect(process.env["GH_TOKEN"]).toBeUndefined();
  });

  it("restores previous GH_TOKEN on failure", async () => {
    process.env["GH_TOKEN"] = "previous-token";

    mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
      const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
      const argsArr = args as string[];
      if (argsArr.some(a => a.includes("access_tokens"))) {
        callback(new Error("API error"), "", "API error");
      } else {
        callback(null, "", "");
      }
      return undefined as never;
    });

    await expect(initGitHubApp()).rejects.toThrow();
    expect(process.env["GH_TOKEN"]).toBe("previous-token");
  });

  it("restores previous GH_TOKEN when setup-git fails", async () => {
    process.env["GH_TOKEN"] = "personal-pat";

    mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
      const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
      const argsArr = args as string[];
      if (argsArr.some(a => a.includes("access_tokens"))) {
        callback(null, JSON.stringify({
          token: "ghs_app_token",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        }), "");
      } else if (argsArr.some(a => a === "/app")) {
        callback(null, JSON.stringify({ slug: "yeti" }), "");
      } else if (argsArr.includes("setup-git")) {
        callback(new Error("setup-git failed"), "", "setup-git failed");
      } else {
        callback(null, "", "");
      }
      return undefined as never;
    });

    await expect(initGitHubApp()).rejects.toThrow("setup-git failed");
    // Must restore the personal token, not delete it
    expect(process.env["GH_TOKEN"]).toBe("personal-pat");
  });

  it("removes GH_TOKEN on setup-git failure when no previous token existed", async () => {
    delete process.env["GH_TOKEN"];

    mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
      const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
      const argsArr = args as string[];
      if (argsArr.some(a => a.includes("access_tokens"))) {
        callback(null, JSON.stringify({
          token: "ghs_app_token",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        }), "");
      } else if (argsArr.some(a => a === "/app")) {
        callback(null, JSON.stringify({ slug: "yeti" }), "");
      } else if (argsArr.includes("setup-git")) {
        callback(new Error("setup-git failed"), "", "setup-git failed");
      } else {
        callback(null, "", "");
      }
      return undefined as never;
    });

    await expect(initGitHubApp()).rejects.toThrow("setup-git failed");
    expect(process.env["GH_TOKEN"]).toBeUndefined();
  });

  it("fails when app slug cannot be determined", async () => {
    mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
      const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
      const argsArr = args as string[];
      if (argsArr.some(a => a.includes("access_tokens"))) {
        callback(null, JSON.stringify({
          token: "ghs_test",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        }), "");
      } else if (argsArr.some(a => a === "/app")) {
        // Simulate /app failure
        callback(new Error("not found"), "", "not found");
      } else {
        callback(null, "", "");
      }
      return undefined as never;
    });

    await expect(initGitHubApp()).rejects.toThrow("could not determine app slug");
    expect(process.env["GH_TOKEN"]).toBeUndefined();
  });

  it("fetches app slug and sets bot login on first init", async () => {
    const { setSelfLogin } = await import("./github.js");
    setupExecMock();

    await initGitHubApp();

    expect(getAppSlug()).toBe("yeti");
    expect(setSelfLogin).toHaveBeenCalledWith("yeti[bot]");
  });
});

describe("ensureGitHubAppToken", () => {
  it("is a no-op when not configured", async () => {
    mockConfig.appId = "";
    mockExecFile.mockClear();
    await ensureGitHubAppToken();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("is a no-op when token is still fresh", async () => {
    setupExecMock();
    await initGitHubApp();

    mockExecFile.mockClear();
    await ensureGitHubAppToken();

    // No new API calls — token has 55+ minutes remaining
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("refreshes when token is within 5 minutes of expiry", async () => {
    // Init with a token that expires in 4 minutes (within 5-min buffer)
    setupExecMock({
      token: "ghs_token_1",
      expires_at: new Date(Date.now() + 4 * 60 * 1000).toISOString(),
    });
    await initGitHubApp();

    expect(process.env["GH_TOKEN"]).toBe("ghs_token_1");

    // Set up mock to return a new token on refresh
    setupExecMock({ token: "ghs_token_2" });

    await ensureGitHubAppToken();
    expect(process.env["GH_TOKEN"]).toBe("ghs_token_2");
  });

  it("deduplicates concurrent refresh calls", async () => {
    // Init with a near-expiry token
    setupExecMock({
      token: "ghs_expiring",
      expires_at: new Date(Date.now() + 60000).toISOString(),
    });
    await initGitHubApp();

    // Set up a delayed mock for the refresh
    let apiCallCount = 0;
    mockExecFile.mockImplementation((_cmd, args, _opts, cb) => {
      const callback = cb as (err: Error | null, stdout: string, stderr: string) => void;
      const argsArr = args as string[];
      if (argsArr.some(a => a.includes("access_tokens"))) {
        apiCallCount++;
        // Resolve immediately
        callback(null, JSON.stringify({
          token: "ghs_dedup",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        }), "");
      } else if (argsArr.some(a => a === "/app")) {
        callback(null, JSON.stringify({ slug: "yeti" }), "");
      } else {
        callback(null, "", "");
      }
      return undefined as never;
    });

    // Fire two concurrent ensure calls
    await Promise.all([ensureGitHubAppToken(), ensureGitHubAppToken()]);

    // Only one API call should have been made (dedup)
    expect(apiCallCount).toBe(1);
  });
});

describe("getAppSlug", () => {
  it("returns null when not initialized", () => {
    expect(getAppSlug()).toBeNull();
  });
});
