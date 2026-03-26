import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

// ── Mocks ──

const mockConfig = {
  allowedRepos: null as readonly string[] | null,
  githubOwners: ["test-org"] as readonly string[],
  selfRepo: "test-org/yeti",
};

vi.mock("./config.js", () => ({
  get ALLOWED_REPOS() { return mockConfig.allowedRepos; },
  get GITHUB_OWNERS() { return mockConfig.githubOwners; },
  get SELF_REPO() { return mockConfig.selfRepo; },
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    priority: "Priority",
    inReview: "In Review",
    needsRefinement: "Needs Refinement",
    needsPlanReview: "Needs Plan Review",
  },
}));

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const mockPopulateQueueCache = vi.fn();
const mockRemoveQueueCacheEntry = vi.fn();
const mockRemoveQueueItem = vi.fn();
const mockUpdateQueueItemPriority = vi.fn();

vi.mock("./github.js", () => ({
  LABEL_TO_CATEGORY: {
    "Needs Refinement": "needs-refinement",
    "Needs Plan Review": "needs-plan-review",
    "Refined": "refined",
    "Ready": "ready",
  },
  populateQueueCache: (...args: unknown[]) => mockPopulateQueueCache(...args),
  removeQueueCacheEntry: (...args: unknown[]) => mockRemoveQueueCacheEntry(...args),
  removeQueueItem: (...args: unknown[]) => mockRemoveQueueItem(...args),
  updateQueueItemPriority: (...args: unknown[]) => mockUpdateQueueItemPriority(...args),
  hasPriorityLabel: (labels: { name: string }[]) => labels.some((l) => l.name === "Priority"),
  isRepoNameAllowed: (repoName: string) => {
    const selfRepoShort = mockConfig.selfRepo.split("/").pop()!.toLowerCase();
    if (repoName.toLowerCase() === selfRepoShort) return true;
    if (mockConfig.allowedRepos === null) return true;
    const allowSet = new Set(mockConfig.allowedRepos.map((r: string) => r.toLowerCase()));
    return allowSet.has(repoName.toLowerCase());
  },
}));

import { verifyWebhookSignature, handleWebhookEvent, isRepoAllowed } from "./webhooks.js";
import type { Scheduler } from "./scheduler.js";

// ── Helpers ──

function makeSignature(secret: string, payload: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(payload);
  return `sha256=${hmac.digest("hex")}`;
}

function mockScheduler(triggerResult: "started" | "already-running" | "unknown" = "started"): Scheduler {
  return {
    triggerJob: vi.fn().mockReturnValue(triggerResult),
    stop: vi.fn(),
    drain: vi.fn(),
    jobStates: vi.fn(),
    updateInterval: vi.fn(),
    updateScheduledHour: vi.fn(),
    pauseJob: vi.fn(),
    resumeJob: vi.fn(),
    pausedJobs: vi.fn(),
    jobScheduleInfo: vi.fn(),
    addJob: vi.fn(),
    removeJob: vi.fn(),
  };
}

function issuePayload(label: string, action: "labeled" | "unlabeled", repo = "test-org/test-repo", issueLabels?: string[]) {
  return {
    action,
    label: { name: label },
    repository: { full_name: repo },
    issue: {
      number: 42,
      title: "Test issue",
      updated_at: "2026-03-24T12:00:00Z",
      labels: (issueLabels ?? [label]).map((name) => ({ name })),
    },
  };
}

function checkRunPayload(conclusion: string, repo = "test-org/test-repo", pullRequests = [{ number: 10 }]) {
  return {
    action: "completed",
    check_run: {
      conclusion,
      pull_requests: pullRequests,
    },
    repository: { full_name: repo },
  };
}

function prReviewPayload(
  state: string,
  action = "submitted",
  repo = "test-org/test-repo",
  headRef = "yeti/issue-42-fix",
  author = "frostyardyeti[bot]",
) {
  return {
    action,
    review: { state },
    pull_request: { number: 10, head: { ref: headRef }, user: { login: author } },
    repository: { full_name: repo },
  };
}

function prPayload(action: string, repo = "test-org/test-repo", number = 10) {
  return {
    action,
    pull_request: { number },
    repository: { full_name: repo },
  };
}

// ── Tests ──

describe("verifyWebhookSignature", () => {
  const secret = "test-secret";

  it("returns true for valid signature", () => {
    const payload = Buffer.from('{"test": true}');
    const sig = makeSignature(secret, payload.toString());
    expect(verifyWebhookSignature(secret, payload, sig)).toBe(true);
  });

  it("returns false for wrong secret", () => {
    const payload = Buffer.from('{"test": true}');
    const sig = makeSignature("wrong-secret", payload.toString());
    expect(verifyWebhookSignature(secret, payload, sig)).toBe(false);
  });

  it("returns false for malformed signature (no sha256= prefix)", () => {
    const payload = Buffer.from('{"test": true}');
    expect(verifyWebhookSignature(secret, payload, "not-a-real-sig")).toBe(false);
  });

  it("returns false for missing signature", () => {
    const payload = Buffer.from('{"test": true}');
    expect(verifyWebhookSignature(secret, payload, "")).toBe(false);
  });

  it("returns true for empty payload with valid signature", () => {
    const payload = Buffer.from("");
    const sig = makeSignature(secret, "");
    expect(verifyWebhookSignature(secret, payload, sig)).toBe(true);
  });
});

describe("handleWebhookEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.allowedRepos = null;
    mockConfig.githubOwners = ["test-org"];
    mockConfig.selfRepo = "test-org/yeti";
  });

  it("returns pong for ping event", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("ping", {}, scheduler);
    expect(result.action).toBe("pong");
  });

  it("triggers issue-worker on Refined label", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("issues", issuePayload("Refined", "labeled"), scheduler);
    expect(scheduler.triggerJob).toHaveBeenCalledWith("issue-worker");
    expect(result.action).toBe("triggered:issue-worker");
  });

  it("triggers issue-refiner on Needs Refinement label", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("issues", issuePayload("Needs Refinement", "labeled"), scheduler);
    expect(scheduler.triggerJob).toHaveBeenCalledWith("issue-refiner");
    expect(result.action).toBe("triggered:issue-refiner");
  });

  it("triggers plan-reviewer on Needs Plan Review label", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("issues", issuePayload("Needs Plan Review", "labeled"), scheduler);
    expect(scheduler.triggerJob).toHaveBeenCalledWith("plan-reviewer");
    expect(result.action).toBe("triggered:plan-reviewer");
  });

  it("updates cache only for Ready label (no job trigger)", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("issues", issuePayload("Ready", "labeled"), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(mockPopulateQueueCache).toHaveBeenCalledWith("ready", "test-org/test-repo", expect.objectContaining({ number: 42 }));
    expect(result.action).toBe("cache-updated");
  });

  it("populates cache with updatedAt and priority from payload", () => {
    const scheduler = mockScheduler();
    const payload = issuePayload("Refined", "labeled", "test-org/test-repo", ["Refined", "Priority"]);
    handleWebhookEvent("issues", payload, scheduler);
    expect(mockPopulateQueueCache).toHaveBeenCalledWith("refined", "test-org/test-repo", {
      number: 42,
      title: "Test issue",
      type: "issue",
      updatedAt: "2026-03-24T12:00:00Z",
      priority: true,
    });
  });

  it("updates prioritized flag when Priority label added", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("issues", issuePayload("Priority", "labeled"), scheduler);
    expect(mockUpdateQueueItemPriority).toHaveBeenCalledWith("test-org/test-repo", 42, true);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("cache-updated");
  });

  it("clears prioritized flag when Priority label removed", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("issues", issuePayload("Priority", "unlabeled"), scheduler);
    expect(mockUpdateQueueItemPriority).toHaveBeenCalledWith("test-org/test-repo", 42, false);
    expect(result.action).toBe("cache-updated");
  });

  it("ignores non-queue non-priority labels", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("issues", issuePayload("bug", "labeled"), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(mockPopulateQueueCache).not.toHaveBeenCalled();
    expect(result.action).toBe("ignored");
  });

  it("skips repos not in allowedRepos", () => {
    mockConfig.allowedRepos = ["other-repo"];
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("issues", issuePayload("Refined", "labeled", "test-org/test-repo"), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("skipped:not-allowed-repo");
  });

  it("removes specific cache entry on unlabeled queue label", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("issues", issuePayload("Refined", "unlabeled"), scheduler);
    expect(mockRemoveQueueCacheEntry).toHaveBeenCalledWith("refined", "test-org/test-repo", 42);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("cache-updated");
  });

  it("returns skipped:job-not-enabled for disabled jobs", () => {
    const scheduler = mockScheduler("unknown");
    const result = handleWebhookEvent("issues", issuePayload("Refined", "labeled"), scheduler);
    expect(result.action).toBe("skipped:job-not-enabled");
  });

  it("returns skipped:already-running for busy jobs", () => {
    const scheduler = mockScheduler("already-running");
    const result = handleWebhookEvent("issues", issuePayload("Refined", "labeled"), scheduler);
    expect(result.action).toBe("skipped:already-running");
  });

  it("triggers ci-fixer on check_run failure", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("check_run", checkRunPayload("failure"), scheduler);
    expect(scheduler.triggerJob).toHaveBeenCalledWith("ci-fixer");
    expect(result.action).toBe("triggered:ci-fixer");
  });

  it("triggers ci-fixer on check_run timed_out", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("check_run", checkRunPayload("timed_out"), scheduler);
    expect(scheduler.triggerJob).toHaveBeenCalledWith("ci-fixer");
    expect(result.action).toBe("triggered:ci-fixer");
  });

  it("ignores check_run success", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("check_run", checkRunPayload("success"), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("ignored");
  });

  it("skips check_run from non-allowed repo", () => {
    mockConfig.allowedRepos = ["other-repo"];
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("check_run", checkRunPayload("failure", "test-org/test-repo"), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("skipped:not-allowed-repo");
  });

  it("skips check_run with no associated PRs", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("check_run", checkRunPayload("failure", "test-org/test-repo", []), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("ignored");
  });

  it("ignores unknown event types", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("push", {}, scheduler);
    expect(result.action).toBe("ignored");
  });

  it("handles malformed payload gracefully", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("issues", { action: "labeled" }, scheduler);
    expect(result.action).toBe("ignored");
  });

  it("handles issues event with non-labeled/unlabeled action", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("issues", { action: "opened" }, scheduler);
    expect(result.action).toBe("ignored");
  });

  // ── pull_request_review events ──

  it("triggers auto-merger on approved review for yeti/issue- branch", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("pull_request_review", prReviewPayload("approved"), scheduler);
    expect(scheduler.triggerJob).toHaveBeenCalledWith("auto-merger");
    expect(result.action).toBe("triggered:auto-merger");
  });

  it("triggers auto-merger on approved review for yeti/improve- branch", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("pull_request_review", prReviewPayload("approved", "submitted", "test-org/test-repo", "yeti/improve-perf"), scheduler);
    expect(scheduler.triggerJob).toHaveBeenCalledWith("auto-merger");
    expect(result.action).toBe("triggered:auto-merger");
  });

  it("triggers auto-merger on approved review from dependabot[bot]", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("pull_request_review", prReviewPayload("approved", "submitted", "test-org/test-repo", "dependabot/npm/lodash-4.0", "dependabot[bot]"), scheduler);
    expect(scheduler.triggerJob).toHaveBeenCalledWith("auto-merger");
    expect(result.action).toBe("triggered:auto-merger");
  });

  it("ignores approved review on non-yeti non-dependabot branch", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("pull_request_review", prReviewPayload("approved", "submitted", "test-org/test-repo", "feature/my-thing", "some-user"), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("ignored");
  });

  it("ignores non-submitted pull_request_review action", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("pull_request_review", prReviewPayload("approved", "dismissed"), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("ignored");
  });

  it("ignores non-approved review state", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("pull_request_review", prReviewPayload("changes_requested"), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("ignored");
  });

  it("skips pull_request_review from non-allowed repo", () => {
    mockConfig.allowedRepos = ["other-repo"];
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("pull_request_review", prReviewPayload("approved"), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("skipped:not-allowed-repo");
  });

  it("returns skipped:already-running for pull_request_review when auto-merger busy", () => {
    const scheduler = mockScheduler("already-running");
    const result = handleWebhookEvent("pull_request_review", prReviewPayload("approved"), scheduler);
    expect(result.action).toBe("skipped:already-running");
  });

  it("returns skipped:job-not-enabled for pull_request_review when auto-merger disabled", () => {
    const scheduler = mockScheduler("unknown");
    const result = handleWebhookEvent("pull_request_review", prReviewPayload("approved"), scheduler);
    expect(result.action).toBe("skipped:job-not-enabled");
  });

  it("handles malformed pull_request_review payload gracefully", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("pull_request_review", { action: "submitted", review: { state: "approved" } }, scheduler);
    expect(result.action).toBe("ignored");
  });

  // ── pull_request events ──

  it("removes queue entries on pull_request closed", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("pull_request", prPayload("closed"), scheduler);
    expect(mockRemoveQueueItem).toHaveBeenCalledWith("test-org/test-repo", 10);
    expect(result.action).toBe("cache-updated");
  });

  it("ignores non-closed pull_request actions", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("pull_request", prPayload("opened"), scheduler);
    expect(mockRemoveQueueItem).not.toHaveBeenCalled();
    expect(result.action).toBe("ignored");
  });

  it("skips pull_request from non-allowed repo", () => {
    mockConfig.allowedRepos = ["other-repo"];
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("pull_request", prPayload("closed"), scheduler);
    expect(mockRemoveQueueItem).not.toHaveBeenCalled();
    expect(result.action).toBe("skipped:not-allowed-repo");
  });

  it("handles malformed pull_request payload gracefully", () => {
    const scheduler = mockScheduler();
    const result = handleWebhookEvent("pull_request", { action: "closed" }, scheduler);
    expect(mockRemoveQueueItem).not.toHaveBeenCalled();
    expect(result.action).toBe("ignored");
  });
});

describe("isRepoAllowed", () => {
  beforeEach(() => {
    mockConfig.allowedRepos = null;
    mockConfig.githubOwners = ["test-org"];
    mockConfig.selfRepo = "test-org/yeti";
  });

  it("allows repo when owner is in GITHUB_OWNERS", () => {
    expect(isRepoAllowed("test-org/some-repo")).toBe(true);
  });

  it("rejects repo when owner not in GITHUB_OWNERS", () => {
    expect(isRepoAllowed("other-org/some-repo")).toBe(false);
  });

  it("allows repo in ALLOWED_REPOS", () => {
    mockConfig.allowedRepos = ["my-repo"];
    expect(isRepoAllowed("test-org/my-repo")).toBe(true);
  });

  it("rejects repo not in ALLOWED_REPOS", () => {
    mockConfig.allowedRepos = ["my-repo"];
    expect(isRepoAllowed("test-org/other-repo")).toBe(false);
  });

  it("always allows SELF_REPO even when not in ALLOWED_REPOS", () => {
    mockConfig.allowedRepos = ["other-repo"];
    expect(isRepoAllowed("test-org/yeti")).toBe(true);
  });

  it("matches repo names case-insensitively", () => {
    mockConfig.allowedRepos = ["My-Repo"];
    expect(isRepoAllowed("test-org/my-repo")).toBe(true);
  });
});
