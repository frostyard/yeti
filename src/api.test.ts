import { describe, expect, it, beforeEach, vi } from "vitest";
import type http from "node:http";

vi.mock("./claude.js", () => ({
  queueStatus: vi.fn(),
  copilotQueueStatus: vi.fn(),
  codexQueueStatus: vi.fn(),
  cancelCurrentTask: vi.fn(),
}));

vi.mock("./config.js", () => ({
  AUTH_TOKEN: "test-token",
  LOG_LEVELS: ["debug", "info", "warn", "error"],
  getConfigForDisplay: vi.fn(),
  getEnvOverrides: vi.fn(),
  writeConfig: vi.fn(),
  repoAutonomy: () => "advisory",
  AUTONOMY_MAP: {},
  DEFAULT_AUTONOMY: "advisory",
}));

vi.mock("./github.js", () => ({
  getQueueSnapshot: vi.fn(),
  enrichQueueItemsWithPRStatus: vi.fn(),
  mergePR: vi.fn(),
  removeQueueItem: vi.fn(),
  listAllOrgRepos: vi.fn(),
  listRepos: vi.fn(),
}));

vi.mock("./db.js", () => ({
  getRecentJobRuns: vi.fn(),
  getRecentWorkItems: vi.fn(),
  getDistinctJobNames: vi.fn(),
  getJobRun: vi.fn(),
  getJobRunLogs: vi.fn(),
  getJobRunLogsSince: vi.fn(),
  getLatestRunIdsByJob: vi.fn(),
  getRunningTasks: vi.fn(),
  getTasksByRunId: vi.fn(),
  getWorkItemsForRuns: vi.fn(),
  searchRunsByItem: vi.fn(),
  getRunsForIssue: vi.fn(),
  getLogsForRuns: vi.fn(),
  getRecentCompletedTasks: vi.fn(),
  getRecentNotifications: vi.fn(),
  getNotificationsSince: vi.fn(),
  getLearnings: vi.fn(),
  countPendingLearnings: vi.fn(),
  dismissLearning: vi.fn(),
}));

vi.mock("./scheduler.js", () => ({
  msUntilHour: vi.fn(),
}));

vi.mock("./discord.js", () => ({
  discordStatus: vi.fn(),
}));

vi.mock("./version.js", () => ({
  VERSION: "test",
}));

vi.mock("./oauth.js", () => ({
  isOAuthConfigured: vi.fn(),
}));

vi.mock("./job-meta.js", () => ({
  JOB_DESCRIPTIONS: {},
}));

vi.mock("./quiesce.js", () => ({
  isUpdatePending: vi.fn(),
  pendingUpdateTag: vi.fn(),
}));

vi.mock("./sysstats.js", () => ({
  getSystemStats: vi.fn(),
}));

const updateCheckMocks = vi.hoisted(() => ({
  requestUpdateCheck: vi.fn(),
}));

vi.mock("./update-check.js", () => ({
  requestUpdateCheck: updateCheckMocks.requestUpdateCheck,
}));

import { buildConfigUpdate, computeTierBlock, handleApi } from "./api.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildConfigUpdate autonomy fields", () => {
  it("accepts valid defaultAutonomy and autonomy entries", () => {
    const { updates } = buildConfigUpdate({
      defaultAutonomy: "pr",
      autonomy: { "frostyard/updex": "automerge" },
    });

    expect(updates.defaultAutonomy).toBe("pr");
    expect(updates.autonomy).toEqual({ "frostyard/updex": "automerge" });
  });

  it("drops invalid autonomy tier values", () => {
    const { updates } = buildConfigUpdate({
      defaultAutonomy: "wat",
      autonomy: { "frostyard/updex": "nope" },
    });

    expect(updates).not.toHaveProperty("defaultAutonomy");
    expect(updates.autonomy).toEqual({});
  });

  it("drops malformed autonomy map keys", () => {
    const { updates } = buildConfigUpdate({
      autonomy: {
        "not-a-repo": "pr",
        "": "pr",
        "owner/repo/extra": "pr",
        "owner repo/name": "pr",
      },
    });

    expect(updates.autonomy).toEqual({});
  });

  it("preserves an empty autonomy map update so entries can be removed", () => {
    const { updates } = buildConfigUpdate({ autonomy: {} });

    expect(updates).toHaveProperty("autonomy");
    expect(updates.autonomy).toEqual({});
  });
});

describe("computeTierBlock", () => {
  it("flags refined items when the repo tier cannot create PRs", () => {
    expect(computeTierBlock("refined", "advisory")).toEqual({
      blockedByTier: "advisory",
      requiredTier: "pr",
    });
  });

  it("does not flag items when the repo tier satisfies the category action", () => {
    expect(computeTierBlock("refined", "pr")).toBeNull();
    expect(computeTierBlock("auto-mergeable", "automerge")).toBeNull();
  });

  it("does not flag categories that only need advisory tier", () => {
    expect(computeTierBlock("needs-refinement", "advisory")).toBeNull();
  });

  it("requires automerge tier for auto-mergeable items", () => {
    expect(computeTierBlock("auto-mergeable", "pr")).toEqual({
      blockedByTier: "pr",
      requiredTier: "automerge",
    });
  });
});

describe("POST /api/update/check", () => {
  it("requires auth before requesting an update check", async () => {
    const { req, res, result } = apiHarness("POST", "/api/update/check");

    await handleApi(req, res, {} as never, [], "2026-01-01T00:00:00.000Z");

    expect(result.status).toBe(401);
    expect(JSON.parse(result.body)).toEqual({ error: "unauthorized" });
    expect(updateCheckMocks.requestUpdateCheck).not.toHaveBeenCalled();
  });

  it("touches the sentinel for an authenticated request", async () => {
    const { req, res, result } = apiHarness("POST", "/api/update/check", {
      authorization: "Bearer test-token",
    });

    await handleApi(req, res, {} as never, [], "2026-01-01T00:00:00.000Z");

    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ result: "requested" });
    expect(updateCheckMocks.requestUpdateCheck).toHaveBeenCalledTimes(1);
  });
});

function apiHarness(method: string, url: string, headers: Record<string, string> = {}) {
  const req = {
    method,
    url,
    headers,
    socket: {},
  } as http.IncomingMessage;

  const result = {
    status: 0,
    headers: undefined as http.OutgoingHttpHeaders | undefined,
    body: "",
  };

  const res = {
    writeHead(status: number, headers?: http.OutgoingHttpHeaders) {
      result.status = status;
      result.headers = headers;
      return this;
    },
    end(chunk?: unknown) {
      result.body = chunk === undefined ? "" : String(chunk);
      return this;
    },
  } as http.ServerResponse;

  return { req, res, result };
}
