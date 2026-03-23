import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockIssue } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    priority: "Priority",
    needsPlanReview: "Needs Plan Review",
    needsRefinement: "Needs Refinement",
  },
  JOB_AI: { "plan-reviewer": { backend: "copilot" } },
  ENABLED_JOBS: ["plan-reviewer"],
}));

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
    mockClaude.createWorktree.mockResolvedValue("/tmp/worktree");
    mockClaude.enqueueCopilot.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.enqueueCodex.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
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

    // Should use enqueueCopilot since JOB_AI has backend: "copilot"
    expect(mockClaude.enqueueCopilot).toHaveBeenCalled();
    expect(mockClaude.enqueue).not.toHaveBeenCalled();

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

    expect(mockClaude.enqueueCodex).toHaveBeenCalled();
    expect(mockClaude.enqueue).not.toHaveBeenCalled();
    expect(mockClaude.enqueueCopilot).not.toHaveBeenCalled();

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
});
