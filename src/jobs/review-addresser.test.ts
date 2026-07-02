import { stripPreamble } from "../test-preamble.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockPR } from "../test-helpers.js";

const { __tier } = vi.hoisted(() => ({ __tier: {} as Record<string, string> }));
vi.mock("../config.js", () => ({
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    priority: "Priority",
  },
  JOB_AI: {},
  // WORK_DIR is pulled in transitively by policy.ts; point it at a dir with no
  // policies/ so renderPolicy falls through to the bundled src/policies template.
  WORK_DIR: "/tmp/yeti-ra-test",
  repoAutonomy: (r: { fullName: string }) => __tier[r.fullName] ?? "pr",
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
    listPRs: vi.fn(),
    getPRReviewComments: vi.fn(),
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    commentOnIssue: vi.fn(),
    updatePRBody: vi.fn(),
    addReaction: vi.fn(),
    addReviewCommentReaction: vi.fn(),
    isRateLimited: vi.fn().mockReturnValue(false),
    isItemSkipped: vi.fn().mockReturnValue(false),
    hasPriorityLabel: vi.fn().mockReturnValue(false),
    populateQueueCache: vi.fn(),
    pullUrl: (fullName: string, number: number) => `https://github.com/${fullName}/pull/${number}`,
  },
  mockClaude: {
    createWorktreeFromBranch: vi.fn(),
    removeWorktree: vi.fn(),
    enqueue: vi.fn(),
    runAI: vi.fn(),
    resolveEnqueue: vi.fn(),
    hasNewCommits: vi.fn(),
    hasTreeDiff: vi.fn(),
    pushBranch: vi.fn(),
    regeneratePRDescription: vi.fn(),
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

import { run, buildPrompt } from "./review-addresser.js";
import { reportError } from "../error-reporter.js";
import type * as gh from "../github.js";

describe("review-addresser", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    for (const k in __tier) delete __tier[k];
    mockGh.listPRs.mockResolvedValue([]);
    mockGh.addLabel.mockResolvedValue(undefined);
    mockGh.removeLabel.mockResolvedValue(undefined);
    mockGh.commentOnIssue.mockResolvedValue(undefined);
    mockGh.addReaction.mockResolvedValue(undefined);
    mockGh.addReviewCommentReaction.mockResolvedValue(undefined);
    mockGh.getPRReviewComments.mockResolvedValue({
      formatted: "Review comment here",
      commentIds: [100],
      reviewCommentIds: [200],
    });
    mockGh.updatePRBody.mockResolvedValue(undefined);
    mockGh.populateQueueCache.mockReturnValue(undefined);
    mockClaude.createWorktreeFromBranch.mockResolvedValue("/tmp/worktree");
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.resolveEnqueue.mockReturnValue(mockClaude.enqueue);
    mockClaude.runAI.mockResolvedValue("addressed");
    mockClaude.hasNewCommits.mockResolvedValue(true);
    mockClaude.hasTreeDiff.mockResolvedValue(true);
    mockClaude.pushBranch.mockResolvedValue(undefined);
    mockClaude.removeWorktree.mockResolvedValue(undefined);
    mockClaude.regeneratePRDescription.mockResolvedValue("## Summary\nUpdated");
  });

  it("happy path — fetches comments, creates worktree, pushes changes, reacts, adds Ready label", async () => {
    const pr = mockPR({ headRefName: "yeti/fix-123" });
    mockGh.listPRs.mockResolvedValue([pr]);

    await run([repo]);

    expect(mockGh.getPRReviewComments).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "Ready");
    expect(mockClaude.createWorktreeFromBranch).toHaveBeenCalledWith(repo, pr.headRefName, "review-addresser");
    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockClaude.regeneratePRDescription).toHaveBeenCalledWith("/tmp/worktree", pr.baseRefName, pr, undefined);
    expect(mockGh.updatePRBody).toHaveBeenCalledWith(repo.fullName, pr.number, "## Summary\nUpdated");
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(repo.fullName, pr.number, "addressed");
    expect(mockGh.addReaction).toHaveBeenCalledWith(repo.fullName, 100, "+1");
    expect(mockGh.addReviewCommentReaction).toHaveBeenCalledWith(repo.fullName, 200, "+1");
    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, pr.number, "Ready");
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      jobName: "review-addresser",
      message: expect.stringContaining("Addressed review"),
    }));
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
  });

  it("autonomy below 'push' — skips repo before any worktree/AI work", async () => {
    const advisoryRepo = mockRepo();
    __tier[advisoryRepo.fullName] = "advisory";
    const pr = mockPR({ headRefName: "yeti/fix-123" });
    mockGh.listPRs.mockResolvedValue([pr]);

    await run([advisoryRepo]);

    // Gate is hoisted to the per-repo loop: skip before even listing PRs.
    expect(mockGh.listPRs).not.toHaveBeenCalled();
    expect(mockClaude.createWorktreeFromBranch).not.toHaveBeenCalled();
    expect(mockClaude.runAI).not.toHaveBeenCalled();
  });

  it("no review comments — skips without creating worktree", async () => {
    const pr = mockPR({ headRefName: "yeti/fix-123" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRReviewComments.mockResolvedValue({
      formatted: "",
      commentIds: [],
      reviewCommentIds: [],
    });

    await run([repo]);

    expect(mockClaude.createWorktreeFromBranch).not.toHaveBeenCalled();
  });

  it("no new commits — no push, no description update, but comment still posted", async () => {
    const pr = mockPR({ headRefName: "yeti/fix-123" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockClaude.hasNewCommits.mockResolvedValue(false);

    await run([repo]);

    expect(mockClaude.pushBranch).not.toHaveBeenCalled();
    expect(mockClaude.regeneratePRDescription).not.toHaveBeenCalled();
    expect(mockGh.updatePRBody).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(repo.fullName, pr.number, "addressed");
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
  });

  it("error — records failure", async () => {
    const pr = mockPR({ headRefName: "yeti/fix-123" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockClaude.runAI.mockRejectedValue(new Error("claude error"));

    await run([repo]);

    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("claude error"));
    expect(reportError).toHaveBeenCalled();
    expect(mockClaude.removeWorktree).toHaveBeenCalled();
  });

  it("no new commits and empty Claude output — no comment posted", async () => {
    const pr = mockPR({ headRefName: "yeti/fix-123" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockClaude.hasNewCommits.mockResolvedValue(false);
    mockClaude.runAI.mockResolvedValue("   ");

    await run([repo]);

    expect(mockClaude.pushBranch).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("posts comment alongside pushed commits", async () => {
    const pr = mockPR({ headRefName: "yeti/fix-123" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockClaude.hasNewCommits.mockResolvedValue(true);
    mockClaude.runAI.mockResolvedValue("Fixed the issue and improved test coverage.");

    await run([repo]);

    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName, pr.number, "Fixed the issue and improved test coverage.",
    );
  });

  it("description update failure — does not fail the task", async () => {
    const pr = mockPR({ headRefName: "yeti/fix-123" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockClaude.regeneratePRDescription.mockRejectedValue(new Error("Claude unavailable"));

    await run([repo]);

    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
    expect(mockDb.recordTaskFailed).not.toHaveBeenCalled();
  });

  it("includes image context in prompt when images are found", async () => {
    const pr = mockPR({ headRefName: "yeti/fix-123" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRReviewComments.mockResolvedValue({
      formatted: "Fix this ![screenshot](https://example.com/review.png)",
      commentIds: [101],
      reviewCommentIds: [],
    });
    mockProcessTextForImages.mockResolvedValueOnce("\n## Attached Images\n- .yeti-images/img-1.png");

    await run([repo]);

    expect(mockProcessTextForImages).toHaveBeenCalledWith(
      ["Fix this ![screenshot](https://example.com/review.png)"],
      "/tmp/worktree",
    );
    const prompt = mockClaude.runAI.mock.calls[0][0] as string;
    expect(prompt).toContain("## Attached Images");
  });

  it("skips non-yeti PRs", async () => {
    const pr = mockPR({ headRefName: "feature-branch" });
    mockGh.listPRs.mockResolvedValue([pr]);

    await run([repo]);

    expect(mockGh.getPRReviewComments).not.toHaveBeenCalled();
    expect(mockClaude.createWorktreeFromBranch).not.toHaveBeenCalled();
  });
});

describe("buildPrompt (policy template)", () => {
  // Reconstructs the pre-migration inline prompt independently, proving the
  // policy-template render is behavior-preserving.
  function expected(fullName: string, pr: gh.PR, reviewData: gh.PRReviewData, imageContext: string): string {
    return [
      `You are addressing PR review comments on a pull request in the repository ${fullName}.`,
      `PR #${pr.number}: ${pr.title}`,
      `Branch: ${pr.headRefName}`,
      ``,
      `The following review comments have been left on this PR:`,
      ``,
      reviewData.formatted,
      ``,
      `Please address each review comment by making the necessary code changes.`,
      `If a review comment is a question or requires no code changes, respond with a text explanation.`,
      `Always include a brief summary of what you did (or why no changes were needed) in your text output.`,
      `Make commits with clear messages as you work.`,
      imageContext,
    ].join("\n");
  }

  const pr = mockPR({ headRefName: "yeti/fix-123" });
  const reviewData: gh.PRReviewData = {
    formatted: "Please rename this variable.",
    commentIds: [1],
    reviewCommentIds: [2],
  };

  it("matches the pre-migration inline builder, no image context", () => {
    const out = buildPrompt("pr", "acme/widget", pr, reviewData, "");
    expect(stripPreamble(out).trimEnd()).toBe(expected("acme/widget", pr, reviewData, "").trimEnd());
  });

  it("substitutes image context when present", () => {
    const out = buildPrompt("pr", "acme/widget", pr, reviewData, "\n## Attached Images\ndiagram.png");
    expect(out).toContain("## Attached Images");
    expect(stripPreamble(out).trimEnd()).toBe(
      expected("acme/widget", pr, reviewData, "\n## Attached Images\ndiagram.png").trimEnd(),
    );
  });
});
