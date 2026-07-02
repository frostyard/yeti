import { describe, expect, it, vi } from "vitest";

vi.mock("./claude.js", () => ({
  queueStatus: vi.fn(),
  copilotQueueStatus: vi.fn(),
  codexQueueStatus: vi.fn(),
  cancelCurrentTask: vi.fn(),
}));

vi.mock("./config.js", () => ({
  LOG_LEVELS: ["debug", "info", "warn", "error"],
  getConfigForDisplay: vi.fn(),
  getEnvOverrides: vi.fn(),
  writeConfig: vi.fn(),
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

import { buildConfigUpdate } from "./api.js";

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
