import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockIssue } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    priority: "Priority",
    needsRefinement: "Needs Refinement",
    needsPlanReview: "Needs Plan Review",
  },
  ENABLED_JOBS: [],
  JOB_AI: {},
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
    getOpenPRForIssue: vi.fn(),
    getCommentReactions: vi.fn(),
    addReaction: vi.fn(),
    getIssueComments: vi.fn(),
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    commentOnIssue: vi.fn(),
    editIssueComment: vi.fn(),
    isYetiComment: (body: string) => body.includes("<!-- yeti-automated -->"),
    stripYetiMarker: (body: string) => body.replace("<!-- yeti-automated -->", "").replace("*— Automated by Yeti —*", "").trim(),
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

const mockProcessTextForImages = vi.hoisted(() => vi.fn().mockResolvedValue(""));
vi.mock("../images.js", () => ({
  processTextForImages: mockProcessTextForImages,
}));

vi.mock("./triage-yeti-errors.js", () => ({
  extractFingerprint: vi.fn().mockReturnValue(null),
}));

import { run } from "./issue-refiner.js";
import { reportError } from "../error-reporter.js";
import { extractFingerprint } from "./triage-yeti-errors.js";

describe("issue-refiner", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockClaude.createWorktree.mockResolvedValue("/tmp/worktree");
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.resolveEnqueue.mockReturnValue(mockClaude.enqueue);
    mockClaude.runAI.mockResolvedValue("## Plan\nDo the thing");
    mockClaude.removeWorktree.mockResolvedValue(undefined);
    mockGh.listOpenIssues.mockResolvedValue([]);
    mockGh.getSelfLogin.mockResolvedValue("yeti-bot[bot]");
    mockGh.getOpenPRForIssue.mockResolvedValue(null);
    mockGh.getCommentReactions.mockResolvedValue([]);
    mockGh.addReaction.mockResolvedValue(undefined);
    mockGh.addLabel.mockResolvedValue(undefined);
    mockGh.removeLabel.mockResolvedValue(undefined);
    mockGh.commentOnIssue.mockResolvedValue(undefined);
    mockGh.editIssueComment.mockResolvedValue(undefined);
    mockGh.getIssueComments.mockResolvedValue([]);
    mockGh.populateQueueCache.mockReturnValue(undefined);
    vi.mocked(extractFingerprint).mockReturnValue(null);
  });

  it("happy path — new plan", async () => {
    const issue = mockIssue({ body: "Test issue body", labels: [{ name: "Needs Refinement" }] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);

    await run([repo]);

    expect(mockClaude.createWorktree).toHaveBeenCalledWith(repo, "yeti/plan-1-ab12", "issue-refiner");
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      issue.number,
      expect.stringContaining("## Implementation Plan"),
    );
    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("[issue-refiner] Plan produced"));
    expect(mockDb.recordTaskStart).toHaveBeenCalledWith("issue-refiner", repo.fullName, issue.number, null);
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
    expect(mockClaude.removeWorktree).toHaveBeenCalled();
  });

  it("includes issue comments in fresh plan prompt", async () => {
    const issue = mockIssue({ body: "Test issue body", labels: [{ name: "Needs Refinement" }] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 901, body: "## Yeti Error Investigation Report\n\nRoot cause: missing null check", login: "yeti-bot" },
    ]);

    await run([repo]);

    const prompt = mockClaude.runAI.mock.calls[0][0] as string;
    expect(prompt).toContain("Yeti Error Investigation Report");
    expect(prompt).toContain("Root cause: missing null check");
  });

  it("empty output — logs warning but still adds Ready label", async () => {
    const issue = mockIssue({ body: "Test issue body", labels: [{ name: "Needs Refinement" }] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockClaude.runAI.mockResolvedValue("");

    await run([repo]);

    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
  });

  it("error handling — records task as failed", async () => {
    const issue = mockIssue({ body: "Test issue body", labels: [{ name: "Needs Refinement" }] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockClaude.runAI.mockRejectedValue(new Error("claude error"));

    await run([repo]);

    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("claude error"));
    expect(reportError).toHaveBeenCalled();
    expect(mockClaude.removeWorktree).toHaveBeenCalled();
  });

  it("refinement — edits existing plan comment in-place", async () => {
    const issue = mockIssue({ body: "Test issue body" });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);

    // Discovery phase: comments include a Yeti plan comment + unreacted human comment
    const planComment = { id: 501, body: "<!-- yeti-automated -->## Implementation Plan\n\nOriginal plan here", login: "yeti-bot" };
    const humanComment = { id: 502, body: "Please also handle edge case X", login: "reviewer" };

    // getIssueComments is called in discovery phase and again inside processRefinement
    mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
    // No reaction on the human comment
    mockGh.getCommentReactions.mockResolvedValue([]);

    await run([repo]);

    expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
    expect(mockGh.editIssueComment).toHaveBeenCalledWith(
      repo.fullName,
      501,
      expect.stringContaining("## Implementation Plan"),
    );
    expect(mockGh.addReaction).toHaveBeenCalledWith(repo.fullName, 502, "+1");
    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
  });

  it("refinement fallback — no plan comment found, posts fresh comment", async () => {
    const issue = mockIssue({ body: "Test issue body" });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);

    // Discovery phase: Yeti plan comment (triggers plan-found path) + unreacted human comment
    const planComment = { id: 601, body: "<!-- yeti-automated -->## Implementation Plan\n\nOld plan", login: "yeti-bot" };
    const humanComment = { id: 602, body: "Just a random comment", login: "someone" };

    // Discovery call sees the plan comment → enters refinement path
    mockGh.getIssueComments
      .mockResolvedValueOnce([planComment, humanComment])  // discovery phase
      .mockResolvedValue([humanComment]);                   // inside processRefinement — plan comment gone

    mockGh.getCommentReactions.mockResolvedValue([]);

    await run([repo]);

    // Falls back to posting a fresh plan since plan comment not found inside processRefinement
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      issue.number,
      expect.stringContaining("## Implementation Plan"),
    );
    expect(mockGh.editIssueComment).not.toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
  });

  it("processes multiple repos and issues, error on one does not stop others", async () => {
    const repo2 = mockRepo({ fullName: "test-org/repo2", name: "repo2" });
    const issue1 = mockIssue({ number: 1, body: "Issue 1 body", labels: [{ name: "Needs Refinement" }] });
    const issue2 = mockIssue({ number: 2, body: "Issue 2 body", labels: [{ name: "Needs Refinement" }] });

    mockGh.listOpenIssues
      .mockResolvedValueOnce([issue1])
      .mockResolvedValueOnce([issue2]);

    // First issue fails, second succeeds
    mockClaude.runAI
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce("plan for issue 2");

    await run([repo, repo2]);

    expect(mockClaude.createWorktree).toHaveBeenCalledTimes(2);
    expect(mockDb.recordTaskFailed).toHaveBeenCalledTimes(1);
    expect(mockDb.recordTaskComplete).toHaveBeenCalledTimes(1);
  });

  it("includes image context in prompt when images are found", async () => {
    const issue = mockIssue({
      body: "Add this: ![design](https://example.com/design.png)",
      labels: [{ name: "Needs Refinement" }],
    });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 1001, body: "Comment with ![img](https://example.com/img2.png)", login: "commenter" },
    ]);
    mockProcessTextForImages.mockResolvedValueOnce("\n## Attached Images\n- .yeti-images/img-1.png");

    await run([repo]);

    expect(mockProcessTextForImages).toHaveBeenCalledWith(
      [issue.body, "Comment with ![img](https://example.com/img2.png)"],
      "/tmp/worktree",
    );
    const prompt = mockClaude.runAI.mock.calls[0][0] as string;
    expect(prompt).toContain("## Attached Images");
  });

  it("skips issues with Refined label", async () => {
    const issue = mockIssue({ body: "Test issue body", labels: [{ name: "Refined" }] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);

    await run([repo]);

    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("skips issues with open PR", async () => {
    const issue = mockIssue({ body: "Test issue body" });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getOpenPRForIssue.mockResolvedValueOnce({ number: 10, headRefName: "yeti/issue-1-abc" });

    await run([repo]);

    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("processes issues with no body", async () => {
    const issue = mockIssue({ body: "", labels: [{ name: "Needs Refinement" }] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);

    await run([repo]);

    expect(mockClaude.createWorktree).toHaveBeenCalled();
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      issue.number,
      expect.stringContaining("## Implementation Plan"),
    );
    const prompt = mockClaude.runAI.mock.calls[0][0] as string;
    expect(prompt).toContain("(No description provided)");
  });

  it("ci-unrelated issue — auto-adds Refined label after first plan", async () => {
    const issue = mockIssue({
      title: "[ci-unrelated] CI failures unrelated to PR changes",
      body: "CI failures detected",
    });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);

    await run([repo]);

    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Refined");
  });

  it("ci-unrelated issue with plan and no feedback — auto-adds Refined label", async () => {
    const issue = mockIssue({
      title: "[ci-unrelated] CI failures unrelated to PR changes",
      body: "CI failures detected",
    });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);

    const planComment = {
      id: 701,
      body: "<!-- yeti-automated -->## Implementation Plan\n\nFix the CI",
      login: "yeti-bot",
    };
    mockGh.getIssueComments.mockResolvedValue([planComment]);

    await run([repo]);

    // Should not invoke Claude (no unreacted feedback)
    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
    // Should auto-add Refined label
    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Refined");
  });

  it("regular issue — does not auto-add Refined label", async () => {
    const issue = mockIssue({ body: "Test issue body", labels: [{ name: "Needs Refinement" }] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);

    await run([repo]);

    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
    expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, issue.number, "Refined");
  });

  it("responds to follow-up comments when issue has open PR", async () => {
    const issue = mockIssue({ body: "Test issue body" });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getOpenPRForIssue.mockResolvedValueOnce({ number: 5, headRefName: "yeti/issue-1-c6b5" });

    const planComment = { id: 501, body: "<!-- yeti-automated -->## Implementation Plan\n\nOriginal plan", login: "yeti-bot" };
    const humanComment = { id: 502, body: "Is everything healthy again?", login: "frostyard" };

    mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
    mockGh.getCommentReactions.mockResolvedValue([]);
    mockClaude.runAI.mockResolvedValue("Yes, everything looks healthy now.");

    await run([repo]);

    // Should post a new comment (not edit the plan)
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      issue.number,
      "Yes, everything looks healthy now.",
    );
    expect(mockGh.editIssueComment).not.toHaveBeenCalled();
    // Should react 👍 to the follow-up comment
    expect(mockGh.addReaction).toHaveBeenCalledWith(repo.fullName, 502, "+1");
    // Should NOT change labels
    expect(mockGh.addLabel).not.toHaveBeenCalled();
    expect(mockGh.removeLabel).not.toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
  });

  it("skips issue with open PR when no unreacted comments", async () => {
    const issue = mockIssue({ body: "Test issue body" });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getOpenPRForIssue.mockResolvedValueOnce({ number: 5, headRefName: "yeti/issue-1-c6b5" });

    const planComment = { id: 501, body: "<!-- yeti-automated -->## Implementation Plan\n\nPlan here", login: "yeti-bot" };
    mockGh.getIssueComments.mockResolvedValue([planComment]);

    await run([repo]);

    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("skips issue with open PR when all follow-up comments already reacted", async () => {
    const issue = mockIssue({ body: "Test issue body" });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getOpenPRForIssue.mockResolvedValueOnce({ number: 5, headRefName: "yeti/issue-1-c6b5" });
    mockGh.getSelfLogin.mockResolvedValue("frostyard");

    const planComment = { id: 501, body: "<!-- yeti-automated -->## Implementation Plan\n\nPlan here", login: "yeti-bot" };
    const humanComment = { id: 502, body: "Is everything healthy?", login: "someone" };
    mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
    // Already has a 👍 reaction from self
    mockGh.getCommentReactions.mockResolvedValue([{ user: { login: "frostyard" }, content: "+1" }]);

    await run([repo]);

    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("skips issues without Needs Refinement label", async () => {
    const issue = mockIssue({ body: "Test issue body", labels: [] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);

    await run([repo]);

    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("removes Needs Refinement label after posting plan", async () => {
    const issue = mockIssue({ body: "Test issue body", labels: [{ name: "Needs Refinement" }] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);

    await run([repo]);

    expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Needs Refinement");
    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
  });

  it("skips [yeti-error] issues without investigation report", async () => {
    const issue = mockIssue({
      title: "[yeti-error] Something broke",
      body: "Error details here",
    });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    vi.mocked(extractFingerprint).mockReturnValue("Something broke");
    // No comments with the investigation report header
    mockGh.getIssueComments.mockResolvedValue([
      { id: 100, body: "Some unrelated comment", login: "someone" },
    ]);

    await run([repo]);

    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("re-plans when Needs Refinement label is present even if a plan already exists", async () => {
    const issue = mockIssue({
      body: "Add dark mode",
      labels: [{ name: "Needs Refinement" }],
    });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getOpenPRForIssue.mockResolvedValue(null);
    mockGh.getIssueComments.mockResolvedValue([
      { id: 100, body: "<!-- yeti-automated -->\n## Implementation Plan\n\nOld plan here", login: "yeti-bot" },
      { id: 101, body: "<!-- yeti-automated -->\n## Plan Review\n\nSome critique", login: "yeti-bot" },
    ]);
    mockClaude.runAI.mockResolvedValue("New fresh plan");

    await run([repo]);

    // Should create a worktree and produce a new plan
    expect(mockClaude.createWorktree).toHaveBeenCalled();
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      issue.number,
      expect.stringContaining("## Implementation Plan"),
    );
  });
});
