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
const mockGetSelfLogin = vi.fn(async () => "yeti-user");

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
  getSelfLogin: () => mockGetSelfLogin(),
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

function issueCommentPayload(action = "created", repo = "test-org/test-repo", author = "human-user", isPR = false) {
  return {
    action,
    repository: { full_name: repo },
    issue: {
      number: 42,
      ...(isPR ? { pull_request: { url: "https://api.github.com/repos/test-org/test-repo/pulls/42" } } : {}),
    },
    comment: { user: { login: author } },
  };
}

function reviewCommentPayload(action = "created", repo = "test-org/test-repo", author = "human-user") {
  return {
    action,
    repository: { full_name: repo },
    pull_request: { number: 10 },
    comment: { user: { login: author } },
  };
}

// ── Tests ──

describe("verifyWebhookSignature", () => {
  const secret = "test-secret";

  it("returns true for valid signature", async () => {
    const payload = Buffer.from('{"test": true}');
    const sig = makeSignature(secret, payload.toString());
    expect(verifyWebhookSignature(secret, payload, sig)).toBe(true);
  });

  it("returns false for wrong secret", async () => {
    const payload = Buffer.from('{"test": true}');
    const sig = makeSignature("wrong-secret", payload.toString());
    expect(verifyWebhookSignature(secret, payload, sig)).toBe(false);
  });

  it("returns false for malformed signature (no sha256= prefix)", async () => {
    const payload = Buffer.from('{"test": true}');
    expect(verifyWebhookSignature(secret, payload, "not-a-real-sig")).toBe(false);
  });

  it("returns false for missing signature", async () => {
    const payload = Buffer.from('{"test": true}');
    expect(verifyWebhookSignature(secret, payload, "")).toBe(false);
  });

  it("returns true for empty payload with valid signature", async () => {
    const payload = Buffer.from("");
    const sig = makeSignature(secret, "");
    expect(verifyWebhookSignature(secret, payload, sig)).toBe(true);
  });
});

describe("handleWebhookEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSelfLogin.mockResolvedValue("yeti-user");
    mockConfig.allowedRepos = null;
    mockConfig.githubOwners = ["test-org"];
    mockConfig.selfRepo = "test-org/yeti";
  });

  it("returns pong for ping event", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("ping", {}, scheduler);
    expect(result.action).toBe("pong");
  });

  it("triggers issue-worker on Refined label", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("issues", issuePayload("Refined", "labeled"), scheduler);
    expect(scheduler.triggerJob).toHaveBeenCalledWith("issue-worker");
    expect(result.action).toBe("triggered:issue-worker");
  });

  it("triggers issue-refiner on Needs Refinement label", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("issues", issuePayload("Needs Refinement", "labeled"), scheduler);
    expect(scheduler.triggerJob).toHaveBeenCalledWith("issue-refiner");
    expect(result.action).toBe("triggered:issue-refiner");
  });

  it("triggers plan-reviewer on Needs Plan Review label", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("issues", issuePayload("Needs Plan Review", "labeled"), scheduler);
    expect(scheduler.triggerJob).toHaveBeenCalledWith("plan-reviewer");
    expect(result.action).toBe("triggered:plan-reviewer");
  });

  it("updates cache only for Ready label (no job trigger)", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("issues", issuePayload("Ready", "labeled"), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(mockPopulateQueueCache).toHaveBeenCalledWith("ready", "test-org/test-repo", expect.objectContaining({ number: 42 }));
    expect(result.action).toBe("cache-updated");
  });

  it("populates cache with updatedAt and priority from payload", async () => {
    const scheduler = mockScheduler();
    const payload = issuePayload("Refined", "labeled", "test-org/test-repo", ["Refined", "Priority"]);
    await handleWebhookEvent("issues", payload, scheduler);
    expect(mockPopulateQueueCache).toHaveBeenCalledWith("refined", "test-org/test-repo", {
      number: 42,
      title: "Test issue",
      type: "issue",
      updatedAt: "2026-03-24T12:00:00Z",
      priority: true,
    });
  });

  it("updates prioritized flag when Priority label added", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("issues", issuePayload("Priority", "labeled"), scheduler);
    expect(mockUpdateQueueItemPriority).toHaveBeenCalledWith("test-org/test-repo", 42, true);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("cache-updated");
  });

  it("clears prioritized flag when Priority label removed", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("issues", issuePayload("Priority", "unlabeled"), scheduler);
    expect(mockUpdateQueueItemPriority).toHaveBeenCalledWith("test-org/test-repo", 42, false);
    expect(result.action).toBe("cache-updated");
  });

  it("ignores non-queue non-priority labels", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("issues", issuePayload("bug", "labeled"), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(mockPopulateQueueCache).not.toHaveBeenCalled();
    expect(result.action).toBe("ignored");
  });

  it("skips repos not in allowedRepos", async () => {
    mockConfig.allowedRepos = ["other-repo"];
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("issues", issuePayload("Refined", "labeled", "test-org/test-repo"), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("skipped:not-allowed-repo");
  });

  it("removes specific cache entry on unlabeled queue label", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("issues", issuePayload("Refined", "unlabeled"), scheduler);
    expect(mockRemoveQueueCacheEntry).toHaveBeenCalledWith("refined", "test-org/test-repo", 42);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("cache-updated");
  });

  it("returns skipped:job-not-enabled for disabled jobs", async () => {
    const scheduler = mockScheduler("unknown");
    const result = await handleWebhookEvent("issues", issuePayload("Refined", "labeled"), scheduler);
    expect(result.action).toBe("skipped:job-not-enabled");
  });

  it("returns skipped:already-running for busy jobs", async () => {
    const scheduler = mockScheduler("already-running");
    const result = await handleWebhookEvent("issues", issuePayload("Refined", "labeled"), scheduler);
    expect(result.action).toBe("skipped:already-running");
  });

  it("triggers ci-fixer on check_run failure", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("check_run", checkRunPayload("failure"), scheduler);
    expect(scheduler.triggerJob).toHaveBeenCalledWith("ci-fixer");
    expect(result.action).toBe("triggered:ci-fixer");
  });

  it("triggers ci-fixer on check_run timed_out", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("check_run", checkRunPayload("timed_out"), scheduler);
    expect(scheduler.triggerJob).toHaveBeenCalledWith("ci-fixer");
    expect(result.action).toBe("triggered:ci-fixer");
  });

  it("ignores check_run success", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("check_run", checkRunPayload("success"), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("ignored");
  });

  it("skips check_run from non-allowed repo", async () => {
    mockConfig.allowedRepos = ["other-repo"];
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("check_run", checkRunPayload("failure", "test-org/test-repo"), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("skipped:not-allowed-repo");
  });

  it("skips check_run with no associated PRs", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("check_run", checkRunPayload("failure", "test-org/test-repo", []), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("ignored");
  });

  it("ignores unknown event types", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("push", {}, scheduler);
    expect(result.action).toBe("ignored");
  });

  it("handles malformed payload gracefully", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("issues", { action: "labeled" }, scheduler);
    expect(result.action).toBe("ignored");
  });

  it("handles issues event with non-labeled/unlabeled action", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("issues", { action: "opened" }, scheduler);
    expect(result.action).toBe("ignored");
  });

  // ── issue_comment events ──

  it("triggers issue-refiner for human comments on issues", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("issue_comment", issueCommentPayload(), scheduler);
    expect(scheduler.triggerJob).toHaveBeenCalledWith("issue-refiner");
    expect(result.action).toBe("triggered:issue-refiner");
  });

  it("triggers review-addresser for human issue comments on PRs", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("issue_comment", issueCommentPayload("created", "test-org/test-repo", "human-user", true), scheduler);
    expect(scheduler.triggerJob).toHaveBeenCalledWith("review-addresser");
    expect(result.action).toBe("triggered:review-addresser");
  });

  it("ignores issue comments from Yeti's own login", async () => {
    mockGetSelfLogin.mockResolvedValue("yeti-user");
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("issue_comment", issueCommentPayload("created", "test-org/test-repo", "yeti-user"), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("skipped:self-or-bot");
  });

  it("ignores issue comments from bot accounts without fetching self login", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("issue_comment", issueCommentPayload("created", "test-org/test-repo", "dependabot[bot]"), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(mockGetSelfLogin).not.toHaveBeenCalled();
    expect(result.action).toBe("skipped:self-or-bot");
  });

  it("ignores non-created issue comments", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("issue_comment", issueCommentPayload("edited"), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("ignored");
  });

  it("skips issue comments from non-allowed repos", async () => {
    mockConfig.allowedRepos = ["other-repo"];
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("issue_comment", issueCommentPayload(), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("skipped:not-allowed-repo");
  });

  it("allows issue comments from SELF_REPO even when not in allowedRepos", async () => {
    mockConfig.allowedRepos = ["other-repo"];
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("issue_comment", issueCommentPayload("created", "test-org/yeti"), scheduler);
    expect(scheduler.triggerJob).toHaveBeenCalledWith("issue-refiner");
    expect(result.action).toBe("triggered:issue-refiner");
  });

  it("handles malformed issue_comment payload gracefully", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("issue_comment", { action: "created" }, scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("ignored");
  });

  // ── pull_request_review_comment events ──

  it("triggers review-addresser for human pull_request_review_comment events", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("pull_request_review_comment", reviewCommentPayload(), scheduler);
    expect(scheduler.triggerJob).toHaveBeenCalledWith("review-addresser");
    expect(result.action).toBe("triggered:review-addresser");
  });

  it("ignores pull_request_review_comment events from Yeti's own login", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("pull_request_review_comment", reviewCommentPayload("created", "test-org/test-repo", "yeti-user"), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("skipped:self-or-bot");
  });

  it("ignores pull_request_review_comment events from bot accounts", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("pull_request_review_comment", reviewCommentPayload("created", "test-org/test-repo", "github-actions[bot]"), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("skipped:self-or-bot");
  });

  it("ignores non-created pull_request_review_comment events", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("pull_request_review_comment", reviewCommentPayload("deleted"), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("ignored");
  });

  it("skips pull_request_review_comment from non-allowed repos", async () => {
    mockConfig.allowedRepos = ["other-repo"];
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("pull_request_review_comment", reviewCommentPayload(), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("skipped:not-allowed-repo");
  });

  it("handles malformed pull_request_review_comment payload gracefully", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("pull_request_review_comment", { action: "created" }, scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("ignored");
  });

  // ── pull_request_review events ──

  it("triggers auto-merger on approved review for yeti/issue- branch", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("pull_request_review", prReviewPayload("approved"), scheduler);
    expect(scheduler.triggerJob).toHaveBeenCalledWith("auto-merger");
    expect(result.action).toBe("triggered:auto-merger");
  });

  it("triggers auto-merger on approved review for yeti/improve- branch", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("pull_request_review", prReviewPayload("approved", "submitted", "test-org/test-repo", "yeti/improve-perf"), scheduler);
    expect(scheduler.triggerJob).toHaveBeenCalledWith("auto-merger");
    expect(result.action).toBe("triggered:auto-merger");
  });

  it("triggers auto-merger on approved review from dependabot[bot]", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("pull_request_review", prReviewPayload("approved", "submitted", "test-org/test-repo", "dependabot/npm/lodash-4.0", "dependabot[bot]"), scheduler);
    expect(scheduler.triggerJob).toHaveBeenCalledWith("auto-merger");
    expect(result.action).toBe("triggered:auto-merger");
  });

  it("ignores approved review on non-yeti non-dependabot branch", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("pull_request_review", prReviewPayload("approved", "submitted", "test-org/test-repo", "feature/my-thing", "some-user"), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("ignored");
  });

  it("ignores non-submitted pull_request_review action", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("pull_request_review", prReviewPayload("approved", "dismissed"), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("ignored");
  });

  it("ignores non-approved review state", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("pull_request_review", prReviewPayload("changes_requested"), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("ignored");
  });

  it("skips pull_request_review from non-allowed repo", async () => {
    mockConfig.allowedRepos = ["other-repo"];
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("pull_request_review", prReviewPayload("approved"), scheduler);
    expect(scheduler.triggerJob).not.toHaveBeenCalled();
    expect(result.action).toBe("skipped:not-allowed-repo");
  });

  it("returns skipped:already-running for pull_request_review when auto-merger busy", async () => {
    const scheduler = mockScheduler("already-running");
    const result = await handleWebhookEvent("pull_request_review", prReviewPayload("approved"), scheduler);
    expect(result.action).toBe("skipped:already-running");
  });

  it("returns skipped:job-not-enabled for pull_request_review when auto-merger disabled", async () => {
    const scheduler = mockScheduler("unknown");
    const result = await handleWebhookEvent("pull_request_review", prReviewPayload("approved"), scheduler);
    expect(result.action).toBe("skipped:job-not-enabled");
  });

  it("handles malformed pull_request_review payload gracefully", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("pull_request_review", { action: "submitted", review: { state: "approved" } }, scheduler);
    expect(result.action).toBe("ignored");
  });

  // ── pull_request events ──

  it("removes queue entries on pull_request closed", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("pull_request", prPayload("closed"), scheduler);
    expect(mockRemoveQueueItem).toHaveBeenCalledWith("test-org/test-repo", 10);
    expect(result.action).toBe("cache-updated");
  });

  it("ignores non-closed pull_request actions", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("pull_request", prPayload("opened"), scheduler);
    expect(mockRemoveQueueItem).not.toHaveBeenCalled();
    expect(result.action).toBe("ignored");
  });

  it("skips pull_request from non-allowed repo", async () => {
    mockConfig.allowedRepos = ["other-repo"];
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("pull_request", prPayload("closed"), scheduler);
    expect(mockRemoveQueueItem).not.toHaveBeenCalled();
    expect(result.action).toBe("skipped:not-allowed-repo");
  });

  it("handles malformed pull_request payload gracefully", async () => {
    const scheduler = mockScheduler();
    const result = await handleWebhookEvent("pull_request", { action: "closed" }, scheduler);
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

  it("allows repo when owner is in GITHUB_OWNERS", async () => {
    expect(isRepoAllowed("test-org/some-repo")).toBe(true);
  });

  it("rejects repo when owner not in GITHUB_OWNERS", async () => {
    expect(isRepoAllowed("other-org/some-repo")).toBe(false);
  });

  it("allows repo in ALLOWED_REPOS", async () => {
    mockConfig.allowedRepos = ["my-repo"];
    expect(isRepoAllowed("test-org/my-repo")).toBe(true);
  });

  it("rejects repo not in ALLOWED_REPOS", async () => {
    mockConfig.allowedRepos = ["my-repo"];
    expect(isRepoAllowed("test-org/other-repo")).toBe(false);
  });

  it("always allows SELF_REPO even when not in ALLOWED_REPOS", async () => {
    mockConfig.allowedRepos = ["other-repo"];
    expect(isRepoAllowed("test-org/yeti")).toBe(true);
  });

  it("matches repo names case-insensitively", async () => {
    mockConfig.allowedRepos = ["My-Repo"];
    expect(isRepoAllowed("test-org/my-repo")).toBe(true);
  });
});
