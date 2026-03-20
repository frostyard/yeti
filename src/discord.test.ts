import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks ──

const { mockConfig, mockClient, mockEventHandlers, mockChannel } = vi.hoisted(() => {
  const mockChannel = {
    send: vi.fn().mockResolvedValue(undefined),
  };

  const mockEventHandlers: Record<string, (...args: unknown[]) => void> = {};

  const mockClient = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      mockEventHandlers[event] = handler;
    }),
    channels: {
      fetch: vi.fn().mockResolvedValue({
        isTextBased: () => true,
        ...mockChannel,
      }),
    },
    login: vi.fn().mockResolvedValue("token"),
    destroy: vi.fn().mockResolvedValue(undefined),
    user: { tag: "TestBot#1234" },
  };

  return {
    mockConfig: {
      DISCORD_BOT_TOKEN: "",
      DISCORD_CHANNEL_ID: "",
      DISCORD_ALLOWED_USERS: [] as string[],
      GITHUB_OWNERS: ["frostyard"],
    },
    mockClient,
    mockEventHandlers,
    mockChannel,
  };
});

vi.mock("discord.js", () => ({
  Client: function Client() { return mockClient; },
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    MessageContent: 4,
  },
}));

vi.mock("./config.js", () => mockConfig);

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./claude.js", () => ({
  queueStatus: vi.fn().mockReturnValue({ pending: 2, active: 1 }),
  enqueue: vi.fn((fn: () => Promise<string>) => fn()),
  runClaude: vi.fn(() => Promise.resolve("This issue is about fixing a bug.")),
}));

vi.mock("./github.js", () => ({
  listRepos: vi.fn(() => Promise.resolve([
    { owner: "frostyard", name: "snosi", fullName: "frostyard/snosi", defaultBranch: "main" },
  ])),
  createIssue: vi.fn(() => Promise.resolve(42)),
  addLabel: vi.fn(() => Promise.resolve()),
  getIssueBody: vi.fn(() => Promise.resolve("Issue body text")),
  getIssueComments: vi.fn(() => Promise.resolve([
    { id: 1, body: "A comment", login: "user1" },
  ])),
}));

import { isDiscordConfigured, discordStatus, notify, start, stop } from "./discord.js";
import * as gh from "./github.js";
import { runClaude } from "./claude.js";
import type { Scheduler } from "./scheduler.js";

function makeMessage(overrides: Partial<{
  bot: boolean;
  channelId: string;
  content: string;
  authorId: string;
}> = {}) {
  return {
    author: { bot: overrides.bot ?? false, id: overrides.authorId ?? "user-1" },
    channelId: overrides.channelId ?? "test-channel",
    content: overrides.content ?? "!yeti help",
    reply: vi.fn().mockResolvedValue(undefined),
  };
}

function makeScheduler(overrides: Partial<Scheduler> = {}): Scheduler {
  return {
    stop: vi.fn(),
    drain: vi.fn().mockResolvedValue(undefined),
    jobStates: vi.fn().mockReturnValue(new Map([["job-a", true], ["job-b", false]])),
    triggerJob: vi.fn().mockReturnValue("started"),
    updateInterval: vi.fn(),
    updateScheduledHour: vi.fn(),
    pauseJob: vi.fn().mockReturnValue(true),
    resumeJob: vi.fn().mockReturnValue(true),
    pausedJobs: vi.fn().mockReturnValue(new Set<string>()),
    jobScheduleInfo: vi.fn().mockReturnValue(undefined),
    addJob: vi.fn(),
    removeJob: vi.fn(),
    ...overrides,
  };
}

describe("isDiscordConfigured", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns false when token and channel are empty", () => {
    mockConfig.DISCORD_BOT_TOKEN = "";
    mockConfig.DISCORD_CHANNEL_ID = "";
    expect(isDiscordConfigured()).toBe(false);
  });

  it("returns false when only token is set", () => {
    mockConfig.DISCORD_BOT_TOKEN = "some-token";
    mockConfig.DISCORD_CHANNEL_ID = "";
    expect(isDiscordConfigured()).toBe(false);
  });

  it("returns false when only channel is set", () => {
    mockConfig.DISCORD_BOT_TOKEN = "";
    mockConfig.DISCORD_CHANNEL_ID = "some-channel";
    expect(isDiscordConfigured()).toBe(false);
  });

  it("returns true when both token and channel are set", () => {
    mockConfig.DISCORD_BOT_TOKEN = "some-token";
    mockConfig.DISCORD_CHANNEL_ID = "some-channel";
    expect(isDiscordConfigured()).toBe(true);
  });
});

describe("discordStatus", () => {
  beforeEach(() => {
    mockConfig.DISCORD_BOT_TOKEN = "";
    mockConfig.DISCORD_CHANNEL_ID = "";
  });

  it("returns correct shape with defaults", () => {
    const status = discordStatus();
    expect(status).toEqual({
      configured: false,
      connected: false,
      lastResult: expect.any(Object), // could be null or previous value
    });
    expect(status).toHaveProperty("configured");
    expect(status).toHaveProperty("connected");
    expect(status).toHaveProperty("lastResult");
  });
});

describe("notify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is no-op when not connected (does not throw)", () => {
    expect(() => notify("hello")).not.toThrow();
  });
});

describe("start and commands", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset event handlers
    Object.keys(mockEventHandlers).forEach((k) => delete mockEventHandlers[k]);

    mockConfig.DISCORD_BOT_TOKEN = "test-token";
    mockConfig.DISCORD_CHANNEL_ID = "test-channel";
    mockConfig.DISCORD_ALLOWED_USERS = ["user-1"];
  });

  it("does not start when not configured", async () => {
    mockConfig.DISCORD_BOT_TOKEN = "";
    mockConfig.DISCORD_CHANNEL_ID = "";
    await start(makeScheduler());
    expect(mockClient.login).not.toHaveBeenCalled();
  });

  it("starts and logs in when configured", async () => {
    await start(makeScheduler());
    expect(mockClient.login).toHaveBeenCalledWith("test-token");
  });

  it("ignores bot messages", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ bot: true });
    mockEventHandlers["messageCreate"](msg);
    expect(msg.reply).not.toHaveBeenCalled();
  });

  it("ignores messages from wrong channel", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ channelId: "other-channel" });
    mockEventHandlers["messageCreate"](msg);
    expect(msg.reply).not.toHaveBeenCalled();
  });

  it("ignores messages not starting with !yeti", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ content: "hello world" });
    mockEventHandlers["messageCreate"](msg);
    expect(msg.reply).not.toHaveBeenCalled();
  });

  it("ignores messages from non-allowlisted users", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ authorId: "not-allowed-user", content: "!yeti status" });
    mockEventHandlers["messageCreate"](msg);
    expect(msg.reply).not.toHaveBeenCalled();
  });

  it("!yeti alone (no command) shows help", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ content: "!yeti" });
    mockEventHandlers["messageCreate"](msg);
    // wait for async handleCommand
    await vi.waitFor(() => {
      expect(msg.reply).toHaveBeenCalled();
    });
    expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("Yeti Commands"));
  });

  it("!yeti help shows help message", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ content: "!yeti help" });
    mockEventHandlers["messageCreate"](msg);
    await vi.waitFor(() => {
      expect(msg.reply).toHaveBeenCalled();
    });
    expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("Yeti Commands"));
  });

  it("!yeti status shows status", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ content: "!yeti status" });
    mockEventHandlers["messageCreate"](msg);
    await vi.waitFor(() => {
      expect(msg.reply).toHaveBeenCalled();
    });
    expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("**Status:**"));
    expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("**Queue:**"));
    expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("**Uptime:**"));
  });

  it("!yeti trigger <job> triggers job", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ content: "!yeti trigger job-a" });
    mockEventHandlers["messageCreate"](msg);
    await vi.waitFor(() => {
      expect(msg.reply).toHaveBeenCalled();
    });
    expect(scheduler.triggerJob).toHaveBeenCalledWith("job-a");
    expect(msg.reply).toHaveBeenCalledWith("Triggered **job-a**");
  });

  it("!yeti trigger without param shows usage", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ content: "!yeti trigger" });
    mockEventHandlers["messageCreate"](msg);
    await vi.waitFor(() => {
      expect(msg.reply).toHaveBeenCalled();
    });
    expect(msg.reply).toHaveBeenCalledWith("Usage: `!yeti trigger <job-name>`");
  });

  it("!yeti pause <job> pauses job", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ content: "!yeti pause job-a" });
    mockEventHandlers["messageCreate"](msg);
    await vi.waitFor(() => {
      expect(msg.reply).toHaveBeenCalled();
    });
    expect(scheduler.pauseJob).toHaveBeenCalledWith("job-a");
    expect(msg.reply).toHaveBeenCalledWith("Paused **job-a**");
  });

  it("!yeti pause without param shows usage", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ content: "!yeti pause" });
    mockEventHandlers["messageCreate"](msg);
    await vi.waitFor(() => {
      expect(msg.reply).toHaveBeenCalled();
    });
    expect(msg.reply).toHaveBeenCalledWith("Usage: `!yeti pause <job-name>`");
  });

  it("!yeti resume <job> resumes job", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ content: "!yeti resume job-b" });
    mockEventHandlers["messageCreate"](msg);
    await vi.waitFor(() => {
      expect(msg.reply).toHaveBeenCalled();
    });
    expect(scheduler.resumeJob).toHaveBeenCalledWith("job-b");
    expect(msg.reply).toHaveBeenCalledWith("Resumed **job-b**");
  });

  it("!yeti resume without param shows usage", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ content: "!yeti resume" });
    mockEventHandlers["messageCreate"](msg);
    await vi.waitFor(() => {
      expect(msg.reply).toHaveBeenCalled();
    });
    expect(msg.reply).toHaveBeenCalledWith("Usage: `!yeti resume <job-name>`");
  });

  it("!yeti jobs lists all jobs", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ content: "!yeti jobs" });
    mockEventHandlers["messageCreate"](msg);
    await vi.waitFor(() => {
      expect(msg.reply).toHaveBeenCalled();
    });
    expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("**job-a**"));
    expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("**job-b**"));
  });

  it("unknown command shows error", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ content: "!yeti foobar" });
    mockEventHandlers["messageCreate"](msg);
    await vi.waitFor(() => {
      expect(msg.reply).toHaveBeenCalled();
    });
    expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("Unknown command: **foobar**"));
  });

  // ── issue command ──

  it("!yeti issue creates issue with valid repo and title", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ content: "!yeti issue snosi Fix bug" });
    mockEventHandlers["messageCreate"](msg);
    await vi.waitFor(() => {
      expect(msg.reply).toHaveBeenCalled();
    });
    expect(gh.createIssue).toHaveBeenCalledWith("frostyard/snosi", "Fix bug", "", []);
    expect(msg.reply).toHaveBeenCalledWith("Created **frostyard/snosi#42**: Fix bug");
  });

  it("!yeti issue shows usage when missing repo", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ content: "!yeti issue" });
    mockEventHandlers["messageCreate"](msg);
    await vi.waitFor(() => {
      expect(msg.reply).toHaveBeenCalled();
    });
    expect(msg.reply).toHaveBeenCalledWith("Usage: `!yeti issue <repo> <title>`");
  });

  it("!yeti issue shows usage when missing title", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ content: "!yeti issue snosi" });
    mockEventHandlers["messageCreate"](msg);
    await vi.waitFor(() => {
      expect(msg.reply).toHaveBeenCalled();
    });
    expect(msg.reply).toHaveBeenCalledWith("Usage: `!yeti issue <repo> <title>`");
  });

  it("!yeti issue shows unknown repo for bad repo", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ content: "!yeti issue badrepo Fix bug" });
    mockEventHandlers["messageCreate"](msg);
    await vi.waitFor(() => {
      expect(msg.reply).toHaveBeenCalled();
    });
    expect(msg.reply).toHaveBeenCalledWith("Unknown repo: **badrepo**");
  });

  // ── look command ──

  it("!yeti look fetches issue data and returns summary", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ content: "!yeti look snosi#10" });
    mockEventHandlers["messageCreate"](msg);
    await vi.waitFor(() => {
      expect(msg.reply).toHaveBeenCalledTimes(2);
    });
    expect(gh.getIssueBody).toHaveBeenCalledWith("frostyard/snosi", 10);
    expect(gh.getIssueComments).toHaveBeenCalledWith("frostyard/snosi", 10);
    expect(runClaude).toHaveBeenCalled();
    expect(msg.reply).toHaveBeenCalledWith("Looking into **frostyard/snosi#10**...");
    expect(msg.reply).toHaveBeenCalledWith("This issue is about fixing a bug.");
  });

  it("!yeti look shows usage for invalid format", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ content: "!yeti look snosi10" });
    mockEventHandlers["messageCreate"](msg);
    await vi.waitFor(() => {
      expect(msg.reply).toHaveBeenCalled();
    });
    expect(msg.reply).toHaveBeenCalledWith("Usage: `!yeti look <repo>#<number>`");
  });

  it("!yeti look shows unknown repo for bad repo", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ content: "!yeti look badrepo#5" });
    mockEventHandlers["messageCreate"](msg);
    await vi.waitFor(() => {
      expect(msg.reply).toHaveBeenCalled();
    });
    expect(msg.reply).toHaveBeenCalledWith("Unknown repo: **badrepo**");
  });

  // ── assign command ──

  it("!yeti assign labels issue as Refined", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ content: "!yeti assign snosi#7" });
    mockEventHandlers["messageCreate"](msg);
    await vi.waitFor(() => {
      expect(msg.reply).toHaveBeenCalled();
    });
    expect(gh.addLabel).toHaveBeenCalledWith("frostyard/snosi", 7, "Refined");
    expect(msg.reply).toHaveBeenCalledWith("Labeled **frostyard/snosi#7** as Refined");
  });

  it("!yeti assign shows usage for invalid format", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ content: "!yeti assign snosi" });
    mockEventHandlers["messageCreate"](msg);
    await vi.waitFor(() => {
      expect(msg.reply).toHaveBeenCalled();
    });
    expect(msg.reply).toHaveBeenCalledWith("Usage: `!yeti assign <repo>#<number>`");
  });

  it("!yeti assign shows unknown repo for bad repo", async () => {
    const scheduler = makeScheduler();
    await start(scheduler);
    const msg = makeMessage({ content: "!yeti assign badrepo#3" });
    mockEventHandlers["messageCreate"](msg);
    await vi.waitFor(() => {
      expect(msg.reply).toHaveBeenCalled();
    });
    expect(msg.reply).toHaveBeenCalledWith("Unknown repo: **badrepo**");
  });

  it("stop destroys client", async () => {
    await start(makeScheduler());
    await stop();
    expect(mockClient.destroy).toHaveBeenCalled();
  });
});
