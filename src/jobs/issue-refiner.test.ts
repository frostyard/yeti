import { stripPreamble } from "../test-preamble.js";
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
  WORK_DIR: "/tmp/yeti-refiner-test",
  repoAutonomy: () => "pr",
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../learnings.js", () => ({
  enforceLearnings: vi.fn().mockResolvedValue(undefined),
  stripLearningsDeclaration: (s: string) => s,
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

import { run, buildNewPlanPrompt, buildRefinementPrompt, buildFollowUpPrompt } from "./issue-refiner.js";
import { reportError } from "../error-reporter.js";
import { extractFingerprint } from "./triage-yeti-errors.js";
import { ENABLED_JOBS } from "../config.js";

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
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      jobName: "issue-refiner",
      message: expect.stringContaining("Plan produced"),
    }));
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

  it("buildNewPlanPrompt includes variant structural elements", async () => {
    const issue = mockIssue({ body: "Add dark mode support", labels: [{ name: "Needs Refinement" }] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);

    await run([repo]);

    const prompt = mockClaude.runAI.mock.calls[0][0] as string;
    // Role framing
    expect(prompt).toContain("senior software engineer");
    // Source-file-reading instruction
    expect(prompt).toContain("read the relevant source files");
    // Four-step structure (evaluate, draft, self-critique, final)
    expect(prompt).toContain("## Step 1");
    expect(prompt).toContain("## Step 2");
    expect(prompt).toContain("## Step 3");
    expect(prompt).toContain("## Step 4");
    // Anti-scope-creep
    expect(prompt).toContain("Do NOT include changes that are not required by the issue");
    // Testing approach requirement
    expect(prompt).toContain("Testing approach");
    // Dependencies section requirement
    expect(prompt).toContain("Dependencies");
    // Actionable clarifying questions guidance
    expect(prompt).toContain("suggest options where possible");
    // Narrowest-interpretation guidance
    expect(prompt).toContain("narrowest reasonable interpretation");
    // Per-file "why" requirement
    expect(prompt).toContain("Why the change is needed");
    // Blocking/non-blocking clarifying questions classification
    expect(prompt).toContain("### Clarifying Questions (blocking)");
    expect(prompt).toContain("### Clarifying Questions (non-blocking)");
    // Replan self-critique dimensions
    expect(prompt).toContain("Unverified assumptions");
    expect(prompt).toContain("Scope discipline");
    // Internal-only output instruction
    expect(prompt).toContain("Do not include your intermediate");
    // Phantom reference detection (Step 1)
    expect(prompt).toContain("planning around a phantom");
    // Anti-gold-plating checklist (Step 2)
    expect(prompt).toContain("### What NOT to plan");
    // Confirm-before-reference rule
    expect(prompt).toContain("confirmed to exist by reading it");
    // Testing pattern conformance
    expect(prompt).toContain("test framework, mock style, fixture conventions");
    // Fifth self-critique check
    expect(prompt).toContain("Completeness vs. gold-plating");
    // Two rounds wording
    expect(prompt).toContain("two rounds");
    // Five checks count
    expect(prompt).toContain("five checks");
    // File count heuristic in scope discipline
    expect(prompt).toContain("Count the files");
    // Import graph tracing in ordering check
    expect(prompt).toContain("import/dependency");
    // Strengthened risk honesty prompts
    expect(prompt).toContain("concurrent access");
    // Revise plan to match reality
    expect(prompt).toContain("revise the plan to match reality");
    // Implementation order step-by-step constraint
    expect(prompt).toContain("build and run tests after each step");
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

  describe("clarifying questions gating", () => {
    it("plan with blocking clarifying questions skips review label (plan-reviewer enabled)", async () => {
      (ENABLED_JOBS as string[]).push("plan-reviewer");
      const issue = mockIssue({ body: "Vague issue", labels: [{ name: "Needs Refinement" }] });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockClaude.runAI.mockResolvedValue("### Clarifying Questions\n\n1. Should X do A or B?");

      await run([repo]);

      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, issue.number, "Needs Plan Review");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
      expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Needs Refinement");
      (ENABLED_JOBS as string[]).length = 0;
    });

    it("normal plan triggers review label (plan-reviewer enabled)", async () => {
      (ENABLED_JOBS as string[]).push("plan-reviewer");
      const issue = mockIssue({ body: "Clear issue", labels: [{ name: "Needs Refinement" }] });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockClaude.runAI.mockResolvedValue("## Plan\nDo the thing");

      await run([repo]);

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Needs Plan Review");
      (ENABLED_JOBS as string[]).length = 0;
    });

    it("plan with clarifying questions + partial plan content still skips review", async () => {
      (ENABLED_JOBS as string[]).push("plan-reviewer");
      const issue = mockIssue({ body: "Semi-clear issue", labels: [{ name: "Needs Refinement" }] });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockClaude.runAI.mockResolvedValue("## Plan\nDo stuff\n\n### Clarifying Questions\n\n1. What about X?");

      await run([repo]);

      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, issue.number, "Needs Plan Review");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
      (ENABLED_JOBS as string[]).length = 0;
    });

    it("non-blocking clarifying questions still trigger review", async () => {
      (ENABLED_JOBS as string[]).push("plan-reviewer");
      const issue = mockIssue({ body: "Mostly clear issue", labels: [{ name: "Needs Refinement" }] });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockClaude.runAI.mockResolvedValue("## Plan\nDo stuff\n\n### Clarifying Questions (non-blocking)\n\n1. Prefer A or B?");

      await run([repo]);

      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Needs Plan Review");
      (ENABLED_JOBS as string[]).length = 0;
    });

    it("refinement with clarifying questions skips review label", async () => {
      const issue = mockIssue({ body: "Test issue body" });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);

      const planComment = { id: 501, body: "<!-- yeti-automated -->## Implementation Plan\n\nOriginal plan", login: "yeti-bot" };
      const humanComment = { id: 502, body: "Please change approach", login: "reviewer" };
      mockGh.getIssueComments.mockResolvedValue([planComment, humanComment]);
      mockGh.getCommentReactions.mockResolvedValue([]);
      mockClaude.runAI.mockResolvedValue("### Clarifying Questions\n\n1. Which approach?");

      await run([repo]);

      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, issue.number, "Needs Plan Review");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
    });

    it("ci-unrelated issue with clarifying questions does not auto-add Refined", async () => {
      const issue = mockIssue({
        title: "[ci-unrelated] CI failures unrelated to PR changes",
        body: "CI failures detected",
      });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockClaude.runAI.mockResolvedValue("### Clarifying Questions\n\n1. Which CI pipeline?");

      await run([repo]);

      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, issue.number, "Refined");
      expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
    });
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

describe("buildNewPlanPrompt (policy template)", () => {
  // Reconstructs the pre-migration inline prompt independently, proving the
  // policy-template render is behavior-preserving.
  function expected(fullName: string, issue: { number: number; title: string; body: string }, comments: { id: number; body: string; login: string }[]): string {
    const isYetiComment = (body: string) => body.includes("<!-- yeti-automated -->");
    const stripYetiMarker = (body: string) => body.replace("<!-- yeti-automated -->", "").replace("*— Automated by Yeti —*", "").trim();
    return [
      `You are a senior software engineer producing an implementation plan for a GitHub issue.`,
      `Repository: ${fullName}`,
      `Issue #${issue.number}: ${issue.title}`,
      ``,
      issue.body || "(No description provided)",
      ``,
      ...comments.flatMap((c) => {
        const label = isYetiComment(c.body)
          ? `Comment by @${c.login} (automated by Yeti):`
          : `Comment by @${c.login}:`;
        return [`---`, label, stripYetiMarker(c.body), ``];
      }),
      `If \`yeti/OVERVIEW.md\` exists in the repository, read it first (and any linked documents that seem relevant to the issue) for context about the codebase architecture and patterns.`,
      ``,
      `Before reading any source files, read the issue carefully and identify which parts of the codebase are likely affected. Then read the relevant source files to ground your plan in the actual code — do not plan changes to files you have not read.`,
      ``,
      `## Step 1: Evaluate whether the issue is plannable`,
      ``,
      `Before producing a plan, assess whether the issue provides enough detail:`,
      `- Is the desired behavior clearly specified?`,
      `- Are acceptance criteria stated or inferable?`,
      `- Are there ambiguous terms or multiple valid interpretations?`,
      `- Is the scope well-defined?`,
      `- Are referenced functions, types, APIs, or file paths verifiable in the codebase? If the issue names something that does not exist, flag it immediately rather than planning around a phantom.`,
      ``,
      `If the issue is underspecified, DO NOT guess or fill in gaps with assumptions. Instead, output a section titled \`### Clarifying Questions\` listing specific questions that would need answers before a reliable plan can be written. Be concrete — reference the parts of the issue that are ambiguous and suggest options where possible (e.g., "Should X behave like A or B?").`,
      ``,
      `After listing your clarifying questions, instruct the user to respond to them as a comment on the GitHub issue so that the next refinement cycle can incorporate their answers and produce a complete plan.`,
      ``,
      `When you have clarifying questions, classify them:`,
      `- Use \`### Clarifying Questions (blocking)\` if any question must be answered before a reliable plan can be written. Output only the questions — no implementation plan, even a partial one. A partial plan built on unverified assumptions adds noise, wastes review compute, and creates false confidence. The user will respond to your questions as a comment; the next refinement cycle will then produce a complete, grounded plan.`,
      `- Use \`### Clarifying Questions (non-blocking)\` if the plan is fully implementable but you want to confirm an assumption or preference. Include the full implementation plan alongside the questions — review will proceed.`,
      ``,
      `## Steps 2–4 apply only when there are no blocking clarifying questions.`,
      `## If the issue has blocking questions, skip directly to output and produce`,
      `## only the clarifying questions from Step 1.`,
      ``,
      `## Step 2: Draft an initial implementation plan`,
      ``,
      `For each file that needs to change, specify:`,
      `- The file path (confirmed to exist by reading it — never reference a file you have not opened)`,
      `- What specifically needs to be added, modified, or removed`,
      `- Why the change is needed (tie it back to the issue requirement)`,
      ``,
      `Also include:`,
      `- **Implementation order**: Which changes should be made first and why (e.g., types before consumers, schema before queries). A developer following your plan step-by-step must be able to build and run tests after each step without errors.`,
      `- **Dependencies**: Note if any change depends on another being completed first`,
      `- **Risks and edge cases**: What could go wrong? What inputs or states might break? What existing behavior might regress? Consider concurrency, error paths, and boundary conditions — not just the happy path.`,
      `- **Testing approach**: How should the changes be verified? Specify whether unit tests, integration tests, or manual verification is appropriate for each change. Name the test files that should be created or modified. Check what testing patterns the repo already uses (test framework, mock style, fixture conventions) and follow them — do not introduce a new testing approach without justification.`,
      ``,
      `Do NOT include changes that are not required by the issue. Do not refactor surrounding code, add nice-to-have improvements, or expand scope beyond what is asked.`,
      ``,
      `If the issue could be interpreted broadly, choose the narrowest reasonable interpretation and note your assumption explicitly so the reviewer can correct it.`,
      ``,
      `### What NOT to plan`,
      `- Do not add logging, metrics, or observability unless the issue asks for it.`,
      `- Do not update documentation files (README, CHANGELOG) unless the issue specifically requires it.`,
      `- Do not add input validation or error handling for scenarios that cannot occur given the code paths involved.`,
      `- Do not rename variables, extract helpers, or "clean up" code adjacent to your changes.`,
      `- If you feel a related improvement is important, mention it in a \`### Future Considerations\` section — do not include it in the plan steps.`,
      ``,
      `## Step 3: Self-critique and revise (two rounds)`,
      ``,
      `After drafting your plan, perform two rounds of structured self-critique`,
      `before producing your final output. For each round, evaluate your current`,
      `plan against these five checks:`,
      ``,
      `1. **Unverified assumptions**: What have I assumed about the codebase that`,
      `I have not confirmed by reading the actual source files? Go back and read`,
      `any files I referenced but did not actually open. Check that the functions,`,
      `types, patterns, and file paths I mentioned actually exist as I described them.`,
      `If I discover something does not exist or works differently than I assumed,`,
      `revise the plan to match reality — do not force reality to match my plan.`,
      ``,
      `2. **Scope discipline**: Am I proposing changes beyond what the issue`,
      `requires? Remove anything that is not directly necessary to satisfy the`,
      `issue's requirements. If I added "while we're at it" improvements, cut them.`,
      `Count the files I'm changing — if the count seems high relative to the issue's`,
      `scope, justify each file or remove it.`,
      ``,
      `3. **Ordering and dependencies**: If a developer followed my plan step-by-step`,
      `in the order I listed, would each step succeed? Or would they hit a compile`,
      `error because a dependency has not been built yet? Trace the import/dependency`,
      `graph of your changes and reorder if needed.`,
      ``,
      `4. **Risk honesty**: What failure modes or edge cases did I omit because they`,
      `would complicate the plan? Add them to the risks section rather than`,
      `pretending they do not exist. Specifically consider: What happens if the input`,
      `is empty, null, or malformed? What happens under concurrent access? What`,
      `existing tests might break?`,
      ``,
      `5. **Completeness vs. gold-plating**: Does my plan actually solve the full`,
      `issue, or did I address only part of it? Conversely, does it solve more than`,
      `what was asked? Both are errors.`,
      ``,
      `After each critique round, revise the plan to address every weakness you`,
      `found. If a critique round reveals no issues, state that explicitly rather`,
      `than inventing problems.`,
      ``,
      `## Step 4: Produce the final plan`,
      ``,
      `Output ONLY your final revised plan. Do not include your intermediate`,
      `drafts, critiques, or revision notes in your output. The output should`,
      `read as a single clean implementation plan. If the issue was not plannable`,
      `(Step 1), output only the clarifying questions — do not invent a plan.`,
      ``,
      [
        `Prefer a single PR. Do not split work into multiple PRs just because the change`,
        `touches several files or is moderately large. A single PR is easier to review,`,
        `test, and deploy. Only use multiple PRs when the work is genuinely too large or`,
        `risky to ship atomically — for example, a schema migration that must be deployed`,
        `before the code that depends on it, or a change that exceeds ~800 lines across`,
        `more than 15 files.`,
        ``,
        `If you do need multiple PRs, use this exact format:`,
        ``,
        `### PR 1: [short title]`,
        `[description, files, changes for this PR]`,
        ``,
        `### PR 2: [short title]`,
        `[description, files, changes for this PR]`,
        ``,
        `Each PR must be independently deployable and functional.`,
        `If the change is small enough for a single PR, you do not need to use this format.`,
      ].join("\n"),
      ``,
      `Do NOT make any code changes. Only produce the plan as text output.`,
    ].join("\n");
  }

  it("matches the pre-migration inline builder — no comments", () => {
    const issue = { number: 3, title: "Add dark mode", body: "Please add a dark mode toggle" };
    const out = buildNewPlanPrompt("pr", "acme/widget", issue as never, []);
    expect(stripPreamble(out).trimEnd()).toBe(expected("acme/widget", issue, []).trimEnd());
  });

  it("matches the pre-migration inline builder — with comments", () => {
    const issue = { number: 4, title: "Fix login bug", body: "Login fails intermittently" };
    const comments = [
      { id: 1, body: "Can you add more detail?", login: "reviewer1", updatedAt: "" },
      { id: 2, body: "<!-- yeti-automated -->Investigated, seems related to session expiry.", login: "yeti-bot", updatedAt: "" },
    ];
    const out = buildNewPlanPrompt("pr", "acme/widget", issue as never, comments);
    expect(stripPreamble(out).trimEnd()).toBe(expected("acme/widget", issue, comments).trimEnd());
  });

  it("uses fallback text when issue body is empty", () => {
    const issue = { number: 5, title: "No body issue", body: "" };
    const out = buildNewPlanPrompt("pr", "acme/widget", issue as never, []);
    expect(stripPreamble(out).trimEnd()).toBe(expected("acme/widget", issue, []).trimEnd());
    expect(out).toContain("(No description provided)");
  });
});

describe("buildRefinementPrompt (policy template)", () => {
  function expected(
    fullName: string,
    issue: { number: number; title: string; body: string },
    existingPlan: string,
    feedback: { id: number; body: string; login: string }[],
  ): string {
    const isYetiComment = (body: string) => body.includes("<!-- yeti-automated -->");
    const stripYetiMarker = (body: string) => body.replace("<!-- yeti-automated -->", "").replace("*— Automated by Yeti —*", "").trim();
    return [
      `You are analyzing a GitHub issue for the repository ${fullName}.`,
      `Issue #${issue.number}: ${issue.title}`,
      ``,
      issue.body || "(No description provided)",
      ``,
      `A previous implementation plan was produced:`,
      ``,
      existingPlan,
      ``,
      ...(feedback.length > 0
        ? [
            `The following feedback was provided on the plan:`,
            ``,
            ...feedback.flatMap((f) => {
              const label = isYetiComment(f.body)
                ? `Comment by @${f.login} (automated by Yeti):`
                : `Comment by @${f.login}:`;
              return [`---`, label, stripYetiMarker(f.body), ``];
            }),
          ]
        : [`No specific feedback comments were provided. Re-evaluate the plan for:`,
            `- Missing files or changes that should be included`,
            `- Edge cases or risks not yet addressed`,
            `- Whether the implementation order is correct`,
            `- Whether the testing approach is sufficient`,
            ``]),
      ``,
      `If \`yeti/OVERVIEW.md\` exists in the repository, read it first (and any linked documents that seem relevant to the issue) for context about the codebase architecture and patterns.`,
      ``,
      `Before revising the plan, read every source file that the feedback references or that the existing plan proposes to change. Do not revise a file-level section of the plan without first reading that file's current contents. If a feedback comment mentions a function, type, or pattern by name, verify it exists and behaves as described before incorporating the suggestion.`,
      ``,
      `## Addressing feedback`,
      ``,
      `Process each feedback comment one at a time, in the order they appear. For each comment:`,
      `1. State which comment you are addressing (quote the key phrase or summarize in one line).`,
      `2. Explain what change you are making to the plan, or why you are not making a change.`,
      `3. If the feedback is ambiguous or you cannot determine the commenter's intent, do NOT guess — add it to the "### Clarifying Questions" section instead.`,
      ``,
      `Do not silently drop or ignore any feedback item. If you disagree with a suggestion, explain why with a concrete technical reason, not just "it's not necessary."`,
      ``,
      `## Scope and preservation rules`,
      ``,
      `Preserve sections of the plan that are not affected by the feedback. Only rewrite sections that need to change. This avoids introducing regressions in already-reviewed parts of the plan.`,
      ``,
      `Stay within the scope of the original issue. If feedback suggests expanding beyond what the issue asks for, note the suggestion in a separate "### Out of Scope" section rather than incorporating it into the plan.`,
      ``,
      `Do not add new files, dependencies, refactors, or "while we're at it" improvements that no feedback comment requested. The goal is a minimal, targeted revision.`,
      ``,
      `## Handling unclear or conflicting feedback`,
      ``,
      `If any feedback is ambiguous or contradictory, output a "### Clarifying Questions" section listing specific questions that need answers before those feedback items can be addressed. For each question:`,
      `- Quote the feedback that triggered it`,
      `- Explain what is ambiguous`,
      `- Suggest concrete options (e.g., "Should X behave like A or B?")`,
      ``,
      `Instruct the user to respond as a comment on the GitHub issue so the next refinement cycle can incorporate their answers.`,
      ``,
      `If two feedback comments contradict each other, do not pick a side. Flag both in the clarifying questions section.`,
      ``,
      `## Verification step`,
      ``,
      `After revising the plan, re-read your changes and check:`,
      `1. Did you address every feedback comment (either by revising the plan, explaining why not, or adding a clarifying question)?`,
      `2. Did you accidentally remove or weaken any risk, edge case, or testing item from the original plan that the feedback did not ask you to remove?`,
      `3. Is the implementation order still correct after your changes, or do revised steps create new ordering dependencies?`,
      ``,
      `If you find issues during verification, fix them before producing output.`,
      ``,
      `## Output format`,
      ``,
      `Produce the updated implementation plan. It must include:`,
      `- Which files need to be changed`,
      `- What the changes should be`,
      `- Any potential risks or edge cases`,
      `- A suggested order of implementation`,
      `- How to verify the changes work (testing approach)`,
      ``,
      [
        `Prefer a single PR. Do not split work into multiple PRs just because the change`,
        `touches several files or is moderately large. A single PR is easier to review,`,
        `test, and deploy. Only use multiple PRs when the work is genuinely too large or`,
        `risky to ship atomically — for example, a schema migration that must be deployed`,
        `before the code that depends on it, or a change that exceeds ~800 lines across`,
        `more than 15 files.`,
        ``,
        `If you do need multiple PRs, use this exact format:`,
        ``,
        `### PR 1: [short title]`,
        `[description, files, changes for this PR]`,
        ``,
        `### PR 2: [short title]`,
        `[description, files, changes for this PR]`,
        ``,
        `Each PR must be independently deployable and functional.`,
        `If the change is small enough for a single PR, you do not need to use this format.`,
      ].join("\n"),
      ``,
      `If there were any surprises or deviations while addressing the feedback, explain them briefly in a separate section at the end of your response, prefixed with \`### Note\``,
      ``,
      `Do NOT make any code changes. Only produce the plan as text output.`,
    ].join("\n");
  }

  it("matches the pre-migration inline builder — with feedback", () => {
    const issue = { number: 7, title: "Add dark mode", body: "Please add a dark mode toggle" };
    const existingPlan = "1. Add a theme context\n2. Wire up the toggle";
    const feedback = [
      { id: 10, body: "Please also handle system preference detection", login: "reviewer", updatedAt: "" },
      { id: 11, body: "<!-- yeti-automated -->\n*— Automated by Yeti —*\nNote: theme persistence not addressed", login: "yeti-bot", updatedAt: "" },
    ];
    const out = buildRefinementPrompt("pr", "acme/widget", issue as never, existingPlan, feedback);
    expect(stripPreamble(out).trimEnd()).toBe(expected("acme/widget", issue, existingPlan, feedback).trimEnd());
  });

  it("matches the pre-migration inline builder — no feedback", () => {
    const issue = { number: 8, title: "Add dark mode", body: "Please add a dark mode toggle" };
    const existingPlan = "1. Add a theme context\n2. Wire up the toggle";
    const out = buildRefinementPrompt("pr", "acme/widget", issue as never, existingPlan, []);
    expect(stripPreamble(out).trimEnd()).toBe(expected("acme/widget", issue, existingPlan, []).trimEnd());
    expect(out).toContain("No specific feedback comments were provided");
  });
});

describe("buildFollowUpPrompt (policy template)", () => {
  function expected(
    fullName: string,
    issue: { number: number; title: string; body: string },
    existingPlan: string,
    openPRNumber: number,
    followUpComments: { id: number; body: string; login: string }[],
  ): string {
    const isYetiComment = (body: string) => body.includes("<!-- yeti-automated -->");
    const stripYetiMarker = (body: string) => body.replace("<!-- yeti-automated -->", "").replace("*— Automated by Yeti —*", "").trim();
    return [
      `You are responding to follow-up questions on a GitHub issue for the repository ${fullName}.`,
      `Issue #${issue.number}: ${issue.title}`,
      ``,
      issue.body || "(No description provided)",
      ``,
      `An implementation plan was already produced and a PR #${openPRNumber} is open to implement it.`,
      ``,
      `Here is the existing plan:`,
      ``,
      existingPlan,
      ``,
      `The following follow-up comments were posted after the plan:`,
      ``,
      ...followUpComments.flatMap((f) => {
        const label = isYetiComment(f.body)
          ? `Comment by @${f.login} (automated by Yeti):`
          : `Comment by @${f.login}:`;
        return [`---`, label, stripYetiMarker(f.body), ``];
      }),
      ``,
      `If \`yeti/OVERVIEW.md\` exists in the repository, read it first (and any linked documents that seem relevant) for context about the codebase architecture and patterns.`,
      ``,
      `Please respond to the follow-up comments above. Answer questions, provide clarifications, or address concerns.`,
      `Do NOT produce a new implementation plan — the implementation is already in progress via PR #${openPRNumber}.`,
      `If the comments suggest changes that should be made to the PR, mention that in your response.`,
      ``,
      `Do NOT make any code changes. Only produce your response as text output.`,
    ].join("\n");
  }

  it("matches the pre-migration inline builder — with follow-up comments", () => {
    const issue = { number: 9, title: "Add dark mode", body: "Please add a dark mode toggle" };
    const existingPlan = "1. Add a theme context\n2. Wire up the toggle";
    const followUpComments = [
      { id: 20, body: "Is this done yet?", login: "reviewer", updatedAt: "" },
    ];
    const out = buildFollowUpPrompt("pr", "acme/widget", issue as never, existingPlan, 42, followUpComments);
    expect(stripPreamble(out).trimEnd()).toBe(expected("acme/widget", issue, existingPlan, 42, followUpComments).trimEnd());
  });

  it("matches the pre-migration inline builder — no follow-up comments", () => {
    const issue = { number: 10, title: "Add dark mode", body: "Please add a dark mode toggle" };
    const existingPlan = "1. Add a theme context\n2. Wire up the toggle";
    const out = buildFollowUpPrompt("pr", "acme/widget", issue as never, existingPlan, 43, []);
    expect(stripPreamble(out).trimEnd()).toBe(expected("acme/widget", issue, existingPlan, 43, []).trimEnd());
  });
});
