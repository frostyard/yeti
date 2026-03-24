import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockIssue } from "../test-helpers.js";

const mockConfig = vi.hoisted(() => ({
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    priority: "Priority",
    needsPlanReview: "Needs Plan Review",
    needsRefinement: "Needs Refinement",
  },
  JOB_AI: { "plan-reviewer": { backend: "copilot" } } as Record<string, { backend?: string; model?: string }>,
  ENABLED_JOBS: ["plan-reviewer"],
  REVIEW_LOOP: false,
  MAX_PLAN_ROUNDS: 3,
}));

vi.mock("../config.js", () => mockConfig);

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

const mockNotify = vi.hoisted(() => vi.fn());
vi.mock("../notify.js", () => ({
  notify: mockNotify,
}));

const { mockGh, mockClaude, mockDb } = vi.hoisted(() => ({
  mockGh: {
    listOpenIssues: vi.fn(),
    getSelfLogin: vi.fn(),
    getCommentReactions: vi.fn(),
    addReaction: vi.fn(),
    getIssueComments: vi.fn(),
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    commentOnIssue: vi.fn(),
    isYetiComment: (body: string) => body.includes("<!-- yeti-automated -->"),
    isRateLimited: vi.fn().mockReturnValue(false),
    isItemSkipped: vi.fn().mockReturnValue(false),
    hasPriorityLabel: vi.fn().mockReturnValue(false),
    populateQueueCache: vi.fn(),
    issueUrl: (fullName: string, number: number) => `https://github.com/${fullName}/issues/${number}`,
  },
  mockClaude: {
    createWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    enqueue: vi.fn(),
    enqueueCopilot: vi.fn(),
    enqueueCodex: vi.fn(),
    runAI: vi.fn(),
    resolveEnqueue: vi.fn(),
    randomSuffix: vi.fn().mockReturnValue("ab12"),
  },
  mockDb: {
    recordTaskStart: vi.fn().mockReturnValue(1),
    updateTaskWorktree: vi.fn(),
    recordTaskComplete: vi.fn(),
    recordTaskFailed: vi.fn(),
  },
}));

vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);

import { run } from "./plan-reviewer.js";
import { reportError } from "../error-reporter.js";

describe("plan-reviewer", () => {
  const repo = mockRepo();
  const planCommentBody = "<!-- yeti-automated -->## Implementation Plan\n\nDo the thing step by step";

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.REVIEW_LOOP = false;
    mockConfig.MAX_PLAN_ROUNDS = 3;
    mockClaude.createWorktree.mockResolvedValue("/tmp/worktree");
    mockClaude.enqueueCopilot.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.enqueueCodex.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.resolveEnqueue.mockReturnValue(mockClaude.enqueue);
    mockClaude.runAI.mockResolvedValue("The plan looks solid but misses error handling for edge case X.");
    mockClaude.removeWorktree.mockResolvedValue(undefined);
    mockGh.listOpenIssues.mockResolvedValue([]);
    mockGh.getSelfLogin.mockResolvedValue("yeti-bot[bot]");
    mockGh.getCommentReactions.mockResolvedValue([]);
    mockGh.addReaction.mockResolvedValue(undefined);
    mockGh.addLabel.mockResolvedValue(undefined);
    mockGh.removeLabel.mockResolvedValue(undefined);
    mockGh.commentOnIssue.mockResolvedValue(undefined);
    mockGh.getIssueComments.mockResolvedValue([]);
    mockGh.populateQueueCache.mockReturnValue(undefined);
  });

  it("reviews an issue with Needs Plan Review label", async () => {
    const issue = mockIssue({
      body: "Add dark mode support",
      labels: [{ name: "Needs Plan Review" }],
    });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 501, body: planCommentBody, login: "yeti-bot" },
    ]);
    mockGh.getCommentReactions.mockResolvedValue([]);

    await run([repo]);

    // Creates worktree for the review
    expect(mockClaude.createWorktree).toHaveBeenCalledWith(repo, "yeti/review-1-ab12", "plan-reviewer");

    // Calls runAI with the plan content
    expect(mockClaude.runAI).toHaveBeenCalledWith(
      expect.stringContaining("## Implementation Plan"),
      "/tmp/worktree",
      { backend: "copilot" },
    );

    // Posts review comment
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      issue.number,
      expect.stringContaining("## Plan Review"),
    );

    // Reacts thumbsup to the plan comment
    expect(mockGh.addReaction).toHaveBeenCalledWith(repo.fullName, 501, "+1");

    // Removes Needs Plan Review label
    expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Needs Plan Review");

    // Adds Ready label
    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");

    // Notifies Discord
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("[plan-reviewer] Review posted"));

    // Records task completion
    expect(mockDb.recordTaskStart).toHaveBeenCalledWith("plan-reviewer", repo.fullName, issue.number, null);
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);

    // Cleans up worktree
    expect(mockClaude.removeWorktree).toHaveBeenCalled();
  });

  it("skips issues without Needs Plan Review label", async () => {
    const issue = mockIssue({ body: "Test issue body", labels: [] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);

    await run([repo]);

    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("skips already-reviewed plans (thumbsup reaction exists)", async () => {
    const issue = mockIssue({
      body: "Test issue body",
      labels: [{ name: "Needs Plan Review" }],
    });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 501, body: planCommentBody, login: "yeti-bot" },
    ]);
    // Plan comment already has a thumbsup from self
    mockGh.getCommentReactions.mockResolvedValue([
      { user: { login: "yeti-bot[bot]" }, content: "+1" },
    ]);

    await run([repo]);

    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("skips issues with Refined label", async () => {
    const issue = mockIssue({
      body: "Test issue body",
      labels: [{ name: "Needs Plan Review" }, { name: "Refined" }],
    });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);

    await run([repo]);

    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("uses configured AI backend from JOB_AI", async () => {
    const issue = mockIssue({
      body: "Test issue body",
      labels: [{ name: "Needs Plan Review" }],
    });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 501, body: planCommentBody, login: "yeti-bot" },
    ]);
    mockGh.getCommentReactions.mockResolvedValue([]);

    await run([repo]);

    // Should call resolveEnqueue with the copilot backend config
    expect(mockClaude.resolveEnqueue).toHaveBeenCalledWith({ backend: "copilot" });

    // runAI should receive the AI options from JOB_AI
    expect(mockClaude.runAI).toHaveBeenCalledWith(
      expect.any(String),
      "/tmp/worktree",
      { backend: "copilot" },
    );
  });

  it("uses enqueueCodex when JOB_AI backend is codex", async () => {
    // Re-mock config with codex backend
    const configMod = await import("../config.js");
    Object.defineProperty(configMod, "JOB_AI", {
      value: { "plan-reviewer": { backend: "codex" } },
      writable: true,
    });

    const issue = mockIssue({
      body: "Test issue body",
      labels: [{ name: "Needs Plan Review" }],
    });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 501, body: planCommentBody, login: "yeti-bot" },
    ]);
    mockGh.getCommentReactions.mockResolvedValue([]);

    await run([repo]);

    expect(mockClaude.resolveEnqueue).toHaveBeenCalledWith({ backend: "codex" });

    // Reset
    Object.defineProperty(configMod, "JOB_AI", {
      value: { "plan-reviewer": { backend: "copilot" } },
      writable: true,
    });
  });

  it("does not mark as processed when review output is empty", async () => {
    const issue = mockIssue({
      body: "Test issue body",
      labels: [{ name: "Needs Plan Review" }],
    });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 501, body: planCommentBody, login: "yeti-bot" },
    ]);
    mockGh.getCommentReactions.mockResolvedValue([]);
    mockClaude.runAI.mockResolvedValue("");

    await run([repo]);

    // Should NOT react, remove label, or post comment
    expect(mockGh.addReaction).not.toHaveBeenCalled();
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();

    // Should record failure so it retries
    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, "Empty review output");
  });

  it("reports error when runAI rejects with non-zero exit", async () => {
    const issue = mockIssue({
      body: "Test issue body",
      labels: [{ name: "Needs Plan Review" }],
    });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 501, body: planCommentBody, login: "yeti-bot" },
    ]);
    mockGh.getCommentReactions.mockResolvedValue([]);
    mockClaude.runAI.mockRejectedValueOnce(
      new Error("Codex exited with code 2: error: unexpected argument '--approval-mode' found"),
    );

    await run([repo]);

    expect(reportError).toHaveBeenCalledWith(
      "plan-reviewer:process-issue",
      expect.stringContaining("#1"),
      expect.any(Error),
    );
    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(
      1,
      expect.stringContaining("Codex exited with code 2"),
    );
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockClaude.removeWorktree).toHaveBeenCalled();
  });

  describe("review loop enabled", () => {
    beforeEach(() => {
      mockConfig.REVIEW_LOOP = true;
    });

    function setupIssueWithReview(reviewOutput: string, existingReviewComments = 0) {
      const issue = mockIssue({
        body: "Add feature X",
        labels: [{ name: "Needs Plan Review" }],
      });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);

      const comments: Array<{ id: number; body: string; login: string }> = [
        { id: 501, body: planCommentBody, login: "yeti-bot" },
      ];
      // Add existing review comments to simulate prior rounds
      for (let i = 0; i < existingReviewComments; i++) {
        comments.push({
          id: 600 + i,
          body: "<!-- yeti-automated -->## Plan Review\n\nPrior review",
          login: "yeti-bot",
        });
      }
      mockGh.getIssueComments.mockResolvedValue(comments);
      mockGh.getCommentReactions.mockResolvedValue([]);
      mockClaude.runAI.mockResolvedValue(reviewOutput);

      return issue;
    }

    it("adds verdict instruction to prompt when review loop is enabled", async () => {
      setupIssueWithReview("Plan looks good.\nVERDICT: APPROVED");

      await run([repo]);

      expect(mockClaude.runAI).toHaveBeenCalledWith(
        expect.stringContaining("VERDICT: APPROVED"),
        "/tmp/worktree",
        { backend: "copilot" },
      );
    });

    it("does not add verdict instruction when review loop is disabled", async () => {
      mockConfig.REVIEW_LOOP = false;
      const issue = mockIssue({
        body: "Add feature X",
        labels: [{ name: "Needs Plan Review" }],
      });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValue([
        { id: 501, body: planCommentBody, login: "yeti-bot" },
      ]);
      mockGh.getCommentReactions.mockResolvedValue([]);

      await run([repo]);

      expect(mockClaude.runAI).toHaveBeenCalledWith(
        expect.not.stringContaining("VERDICT"),
        "/tmp/worktree",
        { backend: "copilot" },
      );
    });

    it("approves: adds Ready label when verdict is APPROVED", async () => {
      const issue = setupIssueWithReview("Plan is solid.\nVERDICT: APPROVED");

      await run([repo]);

      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Needs Plan Review");
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, issue.number, "Needs Refinement");
    });

    it("strips verdict line from posted comment", async () => {
      setupIssueWithReview("Plan is solid.\nVERDICT: APPROVED");

      await run([repo]);

      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        1,
        expect.not.stringContaining("VERDICT"),
      );
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        1,
        expect.stringContaining("Plan is solid."),
      );
    });

    it("needs revision under max rounds: adds Needs Refinement", async () => {
      const issue = setupIssueWithReview("Issues found.\nVERDICT: NEEDS REVISION", 0);

      await run([repo]);

      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Needs Plan Review");
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Needs Refinement");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
    });

    it("needs revision at max rounds: posts warning and adds Ready", async () => {
      mockConfig.MAX_PLAN_ROUNDS = 3;
      // 2 existing reviews + current = 3 = MAX_PLAN_ROUNDS
      const issue = setupIssueWithReview("Still has issues.\nVERDICT: NEEDS REVISION", 2);

      await run([repo]);

      // Should post the max-rounds warning comment
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        issue.number,
        expect.stringContaining("Maximum plan review rounds (3) reached"),
      );
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Needs Plan Review");
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, issue.number, "Needs Refinement");
    });

    it("defaults to needs-revision when no verdict line in output", async () => {
      const issue = setupIssueWithReview("The plan has some issues but no explicit verdict.");

      await run([repo]);

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Needs Refinement");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
    });

    it("verdict parsing is case-insensitive and uses last verdict line", async () => {
      // Earlier mention of APPROVED, but last verdict is NEEDS REVISION
      const issue = setupIssueWithReview(
        "I mentioned VERDICT: APPROVED above but changed my mind.\nverdict: needs revision",
      );

      await run([repo]);

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Needs Refinement");
    });
  });
});
