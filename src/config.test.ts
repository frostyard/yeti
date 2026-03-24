import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// We need to test config.ts without its module-level loadConfig() interfering
// with the test environment. We'll test the exported functions by importing
// after setting up a temp directory.

const tmpDir = path.join(os.tmpdir(), "yeti-config-test-" + process.pid);
const configPath = path.join(tmpDir, "config.json");

// Override WORK_DIR / CONFIG_PATH before importing config
vi.stubEnv("HOME", tmpDir.replace("/.yeti", ""));

// We need to mock the os.homedir to return a temp-friendly path
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => tmpDir.replace("/.yeti", "").replace(path.sep + ".yeti", ""),
    },
  };
});

beforeEach(() => {
  // Clear env vars that would override config file values
  delete process.env["YETI_AUTH_TOKEN"];
  delete process.env["YETI_GITHUB_OWNERS"];
  delete process.env["YETI_SELF_REPO"];
  delete process.env["YETI_LOG_LEVEL"];
  delete process.env["PORT"];
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
  // Clear env vars we may have set
  delete process.env["YETI_AUTH_TOKEN"];
});

// We dynamically import config to get fresh state each time we need it
// But since ESM modules are cached, we'll test the functions that re-read config

describe("config", () => {
  // Use the actual module — the functions we need to test re-read config.json
  // on each call so we can control what they see via the file system.

  it("getConfigForDisplay masks sensitive fields correctly", async () => {
    const { getConfigForDisplay, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.writeFileSync(
      cp,
      JSON.stringify({
        authToken: "my-secret-token-xyz",
        githubOwners: ["owner1"],
        selfRepo: "owner1/repo1",
      }),
    );

    const display = getConfigForDisplay();

    // Sensitive fields should be masked (last 4 chars visible)
    expect(display.authToken).toBe("****-xyz");

    // Non-sensitive fields should be shown as-is
    expect(display.githubOwners).toEqual(["owner1"]);
    expect(display.selfRepo).toBe("owner1/repo1");
  });

  it("getConfigForDisplay shows 'Not configured' for empty sensitive fields", async () => {
    const { getConfigForDisplay, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.writeFileSync(cp, JSON.stringify({}));

    // Remove env vars that would override
    delete process.env["YETI_AUTH_TOKEN"];

    const display = getConfigForDisplay();
    expect(display.authToken).toBe("Not configured");
  });

  it("writeConfig reads, merges, and writes config.json correctly", async () => {
    const { writeConfig, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.writeFileSync(
      cp,
      JSON.stringify({ selfRepo: "old/repo", logRetentionDays: 7 }),
    );

    writeConfig({ selfRepo: "new/repo", logRetentionDays: 30 });

    const written = JSON.parse(fs.readFileSync(cp, "utf-8"));
    expect(written.selfRepo).toBe("new/repo");
    expect(written.logRetentionDays).toBe(30);
  });

  it("writeConfig with empty secret fields does not overwrite existing values", async () => {
    const { writeConfig, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.writeFileSync(
      cp,
      JSON.stringify({ authToken: "existing-token", discordBotToken: "existing-discord" }),
    );

    writeConfig({ authToken: "", discordBotToken: "", selfRepo: "new/repo" });

    const written = JSON.parse(fs.readFileSync(cp, "utf-8"));
    expect(written.authToken).toBe("existing-token");
    expect(written.discordBotToken).toBe("existing-discord");
    expect(written.selfRepo).toBe("new/repo");
  });

  it("writeConfig deep-merges intervals", async () => {
    const { writeConfig, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.writeFileSync(
      cp,
      JSON.stringify({ intervals: { issueWorkerMs: 300000, ciFixerMs: 600000 } }),
    );

    writeConfig({ intervals: { issueWorkerMs: 120000 } });

    const written = JSON.parse(fs.readFileSync(cp, "utf-8"));
    expect(written.intervals.issueWorkerMs).toBe(120000);
    expect(written.intervals.ciFixerMs).toBe(600000); // preserved
  });

  it("writeConfig handles missing config.json gracefully", async () => {
    const { writeConfig, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    // Ensure config.json does not exist
    try { fs.unlinkSync(cp); } catch { /* ok */ }

    writeConfig({ selfRepo: "fresh/repo" });

    const written = JSON.parse(fs.readFileSync(cp, "utf-8"));
    expect(written.selfRepo).toBe("fresh/repo");
  });

  it("reloadConfig updates exported bindings", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({ selfRepo: "reloaded/repo", logRetentionDays: 42 }),
    );

    mod.reloadConfig();

    expect(mod.SELF_REPO).toBe("reloaded/repo");
    expect(mod.LOG_RETENTION_DAYS).toBe(42);
  });

  it("onConfigChange fires listeners after writeConfig", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));

    const listener = vi.fn();
    mod.onConfigChange(listener);

    mod.writeConfig({ logRetentionDays: 99 });

    expect(listener).toHaveBeenCalledTimes(1);

    // Cleanup
    mod.offConfigChange(listener);
  });

  it("GitHub App config fields are loaded from config.json", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({
        githubAppId: "12345",
        githubAppInstallationId: "67890",
        githubAppPrivateKeyPath: "/home/yeti/.yeti/app.pem",
      }),
    );

    // These are immutable (set at import time), so check via getConfigForDisplay
    const display = mod.getConfigForDisplay();
    expect(display.githubAppId).toBe("12345");
    expect(display.githubAppInstallationId).toBe("67890");
    expect(display.githubAppPrivateKeyPath).toBe("/home/yeti/.yeti/app.pem");
  });

  it("GitHub App config fields default to empty strings", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));

    const display = mod.getConfigForDisplay();
    expect(display.githubAppId).toBe("");
    expect(display.githubAppInstallationId).toBe("");
    expect(display.githubAppPrivateKeyPath).toBe("");
  });

  it("GitHub App config fields can be overridden via env vars", async () => {
    process.env["YETI_GITHUB_APP_ID"] = "env-app-id";
    process.env["YETI_GITHUB_APP_INSTALLATION_ID"] = "env-install-id";
    process.env["YETI_GITHUB_APP_PRIVATE_KEY_PATH"] = "/env/path.pem";

    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({
        githubAppId: "file-id",
        githubAppInstallationId: "file-install",
        githubAppPrivateKeyPath: "/file/path.pem",
      }),
    );

    const display = mod.getConfigForDisplay();
    expect(display.githubAppId).toBe("env-app-id");
    expect(display.githubAppInstallationId).toBe("env-install-id");
    expect(display.githubAppPrivateKeyPath).toBe("/env/path.pem");

    delete process.env["YETI_GITHUB_APP_ID"];
    delete process.env["YETI_GITHUB_APP_INSTALLATION_ID"];
    delete process.env["YETI_GITHUB_APP_PRIVATE_KEY_PATH"];
  });

  it("GitHub App config fields are not updated by reloadConfig (immutable)", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));

    const initialId = mod.GITHUB_APP_ID;

    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({ githubAppId: "changed-id" }),
    );
    mod.reloadConfig();

    // Immutable exports should not change on reload
    expect(mod.GITHUB_APP_ID).toBe(initialId);
  });

  it("OAuth config fields are loaded from config.json", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({
        githubAppClientId: "Iv1.abc123",
        githubAppClientSecret: "secret-xyz",
        externalUrl: "https://yeti.example.com",
      }),
    );

    const display = mod.getConfigForDisplay();
    expect(display.githubAppClientId).toBe("Iv1.abc123");
    expect(display.githubAppClientSecret).toBe("****-xyz"); // masked
    expect(display.externalUrl).toBe("https://yeti.example.com");
  });

  it("OAuth config fields default to empty strings", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));

    const display = mod.getConfigForDisplay();
    expect(display.githubAppClientId).toBe("");
    expect(display.githubAppClientSecret).toBe("Not configured");
    expect(display.externalUrl).toBe("");
  });

  it("externalUrl trailing slashes are stripped", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({ externalUrl: "https://yeti.example.com///" }),
    );

    const display = mod.getConfigForDisplay();
    expect(display.externalUrl).toBe("https://yeti.example.com");
  });

  it("externalUrl is cleared when invalid protocol and client ID/secret set", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({
        githubAppClientId: "Iv1.abc123",
        githubAppClientSecret: "secret-xyz",
        externalUrl: "ftp://invalid.example.com",
      }),
    );

    const display = mod.getConfigForDisplay();
    expect(display.externalUrl).toBe("");
  });

  it("OAuth config fields are not updated by reloadConfig (immutable)", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));

    const initialClientId = mod.GITHUB_APP_CLIENT_ID;

    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({ githubAppClientId: "changed-id" }),
    );
    mod.reloadConfig();

    expect(mod.GITHUB_APP_CLIENT_ID).toBe(initialClientId);
  });

  it("githubAppClientSecret is in SENSITIVE_KEYS and masked in display", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({ githubAppClientSecret: "abcdefgh" }),
    );

    const display = mod.getConfigForDisplay();
    expect(display.githubAppClientSecret).toBe("****efgh");
  });

  it("logLevel defaults to debug when not set", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));

    const display = mod.getConfigForDisplay();
    expect(display.logLevel).toBe("debug");
  });

  it("logLevel loads from config.json", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ logLevel: "warn" }));

    const display = mod.getConfigForDisplay();
    expect(display.logLevel).toBe("warn");
  });

  it("invalid logLevel in config.json falls back to debug", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ logLevel: "bogus" }));

    const display = mod.getConfigForDisplay();
    expect(display.logLevel).toBe("debug");
  });

  it("YETI_LOG_LEVEL env var overrides config.json", async () => {
    process.env["YETI_LOG_LEVEL"] = "error";

    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ logLevel: "info" }));

    const display = mod.getConfigForDisplay();
    expect(display.logLevel).toBe("error");

    delete process.env["YETI_LOG_LEVEL"];
  });

  it("invalid YETI_LOG_LEVEL falls back to valid config.json value", async () => {
    process.env["YETI_LOG_LEVEL"] = "invalid";

    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ logLevel: "warn" }));

    const display = mod.getConfigForDisplay();
    expect(display.logLevel).toBe("warn");

    delete process.env["YETI_LOG_LEVEL"];
  });

  it("reloadConfig updates LOG_LEVEL binding", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ logLevel: "error" }));

    mod.reloadConfig();

    expect(mod.LOG_LEVEL).toBe("error");
  });

  it("reviewLoop defaults to false and maxPlanRounds defaults to 3", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));

    const display = mod.getConfigForDisplay();
    expect(display.reviewLoop).toBe(false);
    expect(display.maxPlanRounds).toBe(3);
  });

  it("reloadConfig updates REVIEW_LOOP and MAX_PLAN_ROUNDS", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ reviewLoop: true, maxPlanRounds: 5 }));

    mod.reloadConfig();

    expect(mod.REVIEW_LOOP).toBe(true);
    expect(mod.MAX_PLAN_ROUNDS).toBe(5);
  });

  it("writeConfig persists reviewLoop and maxPlanRounds", async () => {
    const { writeConfig, CONFIG_PATH: cp } = await import("./config.js");

    fs.mkdirSync(path.dirname(cp), { recursive: true });
    fs.writeFileSync(cp, JSON.stringify({}));

    writeConfig({ reviewLoop: true, maxPlanRounds: 4 });

    const written = JSON.parse(fs.readFileSync(cp, "utf-8"));
    expect(written.reviewLoop).toBe(true);
    expect(written.maxPlanRounds).toBe(4);
  });

  it("maxPlanRounds falls back to 3 for non-numeric values", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ maxPlanRounds: "not-a-number" }));

    const display = mod.getConfigForDisplay();
    expect(display.maxPlanRounds).toBe(3);
  });

  it("maxPlanRounds clamps values below 1 and floors floats", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ maxPlanRounds: 0 }));

    let display = mod.getConfigForDisplay();
    expect(display.maxPlanRounds).toBe(3); // falls back to default

    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({ maxPlanRounds: 2.7 }));
    display = mod.getConfigForDisplay();
    expect(display.maxPlanRounds).toBe(2); // floored
  });

  it("offConfigChange removes listener", async () => {
    const mod = await import("./config.js");

    fs.mkdirSync(path.dirname(mod.CONFIG_PATH), { recursive: true });
    fs.writeFileSync(mod.CONFIG_PATH, JSON.stringify({}));

    const listener = vi.fn();
    mod.onConfigChange(listener);
    mod.offConfigChange(listener);

    mod.writeConfig({ logRetentionDays: 50 });

    expect(listener).not.toHaveBeenCalled();
  });
});
