import { stripPreamble } from "../test-preamble.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockPR } from "../test-helpers.js";
import { ShutdownError } from "../shutdown.js";
import type * as gh from "../github.js";

const { __tier } = vi.hoisted(() => ({ __tier: {} as Record<string, string> }));
vi.mock("../config.js", () => ({
  JOB_AI: {},
  WORK_DIR: "/tmp/yeti-cifix-test",
  repoAutonomy: (r: { fullName: string } | undefined) => __tier[r?.fullName ?? ""] ?? "pr",
}));

const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../log.js", () => mockLog);

const mockEnforceLearnings = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../learnings.js", () => ({
  enforceLearnings: mockEnforceLearnings,
  stripLearningsDeclaration: (s: string) => s,
}));

const mockReportError = vi.hoisted(() => vi.fn());

vi.mock("../error-reporter.js", () => ({
  reportError: mockReportError,
}));

const mockNotify = vi.hoisted(() => vi.fn());
vi.mock("../notify.js", () => ({
  notify: mockNotify,
}));

const { mockGh, mockClaude, mockDb, MockRateLimitError } = vi.hoisted(() => {
  class MockRateLimitError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "RateLimitError";
    }
  }
  return {
  MockRateLimitError,
  mockGh: {
    listPRs: vi.fn(),
    prChecksPassing: vi.fn(),
    prChecksFailing: vi.fn(),
    mergePR: vi.fn(),
    getFailingCheck: vi.fn(),
    getFailedRunLog: vi.fn(),
    rerunWorkflow: vi.fn(),
    getPRMergeableState: vi.fn(),
    updatePRBody: vi.fn(),
    isRateLimited: vi.fn().mockReturnValue(false),
    isItemSkipped: vi.fn().mockReturnValue(false),
    hasPriorityLabel: vi.fn().mockReturnValue(false),
    getPRChangedFiles: vi.fn(),
    searchIssues: vi.fn(),
    createIssue: vi.fn(),
    commentOnIssue: vi.fn(),
    getIssueComments: vi.fn(),
    editIssueComment: vi.fn(),
    isYetiComment: vi.fn(),
    RateLimitError: MockRateLimitError,
    issueUrl: (fullName: string, number: number) => `https://github.com/${fullName}/issues/${number}`,
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
    attemptMerge: vi.fn(),
    abortMerge: vi.fn(),
    getHeadSha: vi.fn(),
    getNewCommitShas: vi.fn(),
    commitsOnBranch: vi.fn(),
    getRevertedShas: vi.fn(),
    revertCommit: vi.fn(),
    abortRevert: vi.fn(),
    resetHard: vi.fn(),
    git: vi.fn(),
  },
  mockDb: {
    recordTaskStart: vi.fn().mockReturnValue(1),
    updateTaskWorktree: vi.fn(),
    recordTaskComplete: vi.fn(),
    recordTaskFailed: vi.fn(),
    recordTaskCommits: vi.fn(),
    hasPreviousCiFixerTasks: vi.fn(),
    getCiFixerFixCommitShas: vi.fn(),
  },
};});

vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);

import {
  run,
  buildConflictPrompt,
  buildClassifyPrompt,
  buildFixPrompt,
  buildRevertPrompt,
  deriveFingerprint,
  extractFailingPaths,
  hasFileOverlap,
  parseClassification,
} from "./ci-fixer.js";

describe("ci-fixer classification helpers", () => {
  it("extractFailingPaths finds common test, diagnostic, root, and extensionless paths", () => {
    expect(extractFailingPaths([
      " FAIL src/foo.test.ts > suite",
      "src/bar.ts:12:3 - error TS2322",
      "npm ERR! package.json failed validation",
      "make: *** [Makefile:10: test] Error 2",
    ].join("\n"))).toEqual(["Makefile", "package.json", "src/bar.ts", "src/foo.test.ts"]);
    expect(extractFailingPaths("error: no file paths here")).toEqual([]);
  });

  it("hasFileOverlap uses strict full-path intersection with one-way prefixed log matching", () => {
    expect(hasFileOverlap(["src/app.ts"], ["src/app.ts"])).toBe(true);
    expect(hasFileOverlap(["/home/runner/work/repo/repo/src/app.ts"], ["src/app.ts"])).toBe(true);
    expect(hasFileOverlap(["src/b/index.ts"], ["src/a/index.ts"])).toBe(false);
    expect(hasFileOverlap(["package.json"], ["packages/foo/package.json"])).toBe(false);
    expect(hasFileOverlap(["src/x/package.json"], ["package.json"])).toBe(false);
    expect(hasFileOverlap(["package.json"], ["package.json"])).toBe(true);
    expect(hasFileOverlap(["src/app.ts"], ["src/other.ts"])).toBe(false);
    expect(hasFileOverlap([], ["src/app.ts"])).toBe(false);
    expect(hasFileOverlap(["src/app.ts"], [])).toBe(false);
  });

  it("deriveFingerprint is deterministic from check name and sorted failing path", () => {
    expect(deriveFingerprint("CI / Unit Tests", "src/app.test.ts")).toBe("ci-unit-tests:src/app.test.ts");
    expect(deriveFingerprint("CI / Unit Tests", "src/app.test.ts")).toBe(deriveFingerprint("CI / Unit Tests", "src/app.test.ts"));

    const firstPath = extractFailingPaths("src/z.test.ts:1:1\nsrc/a.test.ts:1:1")[0];
    expect(deriveFingerprint("CI", firstPath)).toBe("ci:src/a.test.ts");
    expect(deriveFingerprint("CI", undefined)).toBe("ci");
  });

  it("parseClassification accepts schema-valid JSON and rejects malformed output", () => {
    expect(parseClassification('{"related":false,"reason":"flaky"}')).toEqual({ related: false, reason: "flaky" });
    expect(parseClassification('{"related":"false","reason":"flaky"}')).toBeNull();
    expect(parseClassification("not json")).toBeNull();
  });
});

describe("ci-fixer", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    for (const k in __tier) delete __tier[k];
    mockGh.listPRs.mockResolvedValue([]);
    mockGh.mergePR.mockResolvedValue(undefined);
    mockGh.rerunWorkflow.mockResolvedValue(undefined);
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
    mockGh.getPRChangedFiles.mockResolvedValue(["src/app.ts"]);
    mockGh.searchIssues.mockResolvedValue([]);
    mockGh.createIssue.mockResolvedValue(99);
    mockGh.commentOnIssue.mockResolvedValue(undefined);
    mockGh.getIssueComments.mockResolvedValue([]);
    mockGh.editIssueComment.mockResolvedValue(undefined);
    mockGh.isYetiComment.mockReturnValue(false);
    mockClaude.createWorktreeFromBranch.mockResolvedValue("/tmp/worktree");
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.resolveEnqueue.mockReturnValue(mockClaude.enqueue);
    mockClaude.runAI.mockResolvedValue('{"related": true, "fingerprint": "", "reason": "related to PR"}');
    mockClaude.hasNewCommits.mockResolvedValue(true);
    mockClaude.hasTreeDiff.mockResolvedValue(true);
    mockClaude.pushBranch.mockResolvedValue(undefined);
    mockClaude.removeWorktree.mockResolvedValue(undefined);
    mockClaude.regeneratePRDescription.mockResolvedValue("## Summary\nUpdated");
    mockClaude.getHeadSha.mockResolvedValue("start-sha");
    mockClaude.getNewCommitShas.mockResolvedValue(["fix-sha"]);
    mockClaude.commitsOnBranch.mockResolvedValue([]);
    mockClaude.getRevertedShas.mockResolvedValue([]);
    mockClaude.revertCommit.mockResolvedValue({ clean: true });
    mockClaude.abortRevert.mockResolvedValue(undefined);
    mockClaude.resetHard.mockResolvedValue(undefined);
    mockClaude.git.mockResolvedValue("abc123 some commit");
    mockGh.updatePRBody.mockResolvedValue(undefined);
    mockDb.hasPreviousCiFixerTasks.mockReturnValue(false);
    mockDb.getCiFixerFixCommitShas.mockReturnValue([]);
  });

  it("cancelled check — re-runs workflow, does NOT attempt code fix", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.prChecksPassing.mockResolvedValue(false);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "CANCELLED",
      link: "https://github.com/org/repo/actions/runs/555/jobs/1",
    });

    await run([repo]);

    expect(mockGh.rerunWorkflow).toHaveBeenCalledWith(repo.fullName, "555");
    expect(mockClaude.createWorktreeFromBranch).not.toHaveBeenCalled();
  });

  it("rerun silently skips when workflow is already running", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.prChecksPassing.mockResolvedValue(false);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "CANCELLED",
      link: "https://github.com/org/repo/actions/runs/555/jobs/1",
    });
    mockGh.rerunWorkflow.mockRejectedValue(
      new Error("run 555 cannot be rerun; This workflow is already running"),
    );

    await run([repo]);

    expect(mockGh.rerunWorkflow).toHaveBeenCalledWith(repo.fullName, "555");
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it("autonomy below 'push' — skips repo before any worktree/AI work", async () => {
    const advisoryRepo = mockRepo();
    __tier[advisoryRepo.fullName] = "advisory";
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: test failed");

    await run([advisoryRepo]);

    expect(mockGh.listPRs).not.toHaveBeenCalled();
    expect(mockClaude.createWorktreeFromBranch).not.toHaveBeenCalled();
    expect(mockClaude.runAI).not.toHaveBeenCalled();
  });

  it("related failure — proceeds with fix as before", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: test failed");
    // Classification returns related
    mockClaude.runAI
      .mockResolvedValueOnce('{"related": true, "fingerprint": "", "reason": "test failure in changed file"}')
      .mockResolvedValueOnce("fixed");

    await run([repo]);

    expect(mockGh.getPRChangedFiles).toHaveBeenCalledWith(repo.fullName, pr.number);
    expect(mockClaude.createWorktreeFromBranch).toHaveBeenCalledWith(repo, pr.headRefName, "ci-fixer");
    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockClaude.getNewCommitShas).toHaveBeenCalledWith("/tmp/worktree", "start-sha");
    expect(mockDb.recordTaskCommits).toHaveBeenCalledWith(1, ["fix-sha"]);
    expect(mockClaude.regeneratePRDescription).toHaveBeenCalledWith("/tmp/worktree", pr.baseRefName, pr, undefined);
    expect(mockGh.updatePRBody).toHaveBeenCalledWith(repo.fullName, pr.number, "## Summary\nUpdated");
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      jobName: "ci-fixer",
      message: expect.stringContaining("Pushed fix"),
    }));
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
  });

  it("related failure — captures SHAs produced by a pushed fix", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: test failed");
    mockClaude.runAI
      .mockResolvedValueOnce('{"related": true, "fingerprint": "", "reason": "related"}')
      .mockResolvedValueOnce("fixed");
    mockClaude.getHeadSha.mockResolvedValue("pre-fix-sha");
    mockClaude.getNewCommitShas.mockResolvedValue(["sha-one", "sha-two"]);

    await run([repo]);

    expect(mockClaude.getHeadSha).toHaveBeenCalledWith("/tmp/worktree");
    expect(mockClaude.getNewCommitShas).toHaveBeenCalledWith("/tmp/worktree", "pre-fix-sha");
    expect(mockDb.recordTaskCommits).toHaveBeenCalledWith(1, ["sha-one", "sha-two"]);
  });

  it("overlapping changed source file — skips AI classification and proceeds with fix", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("src/app.ts:12:3 - error TS2322");
    mockGh.getPRChangedFiles.mockResolvedValue(["src/app.ts"]);
    mockClaude.runAI.mockResolvedValueOnce("fixed");

    await run([repo]);

    expect(mockClaude.runAI).toHaveBeenCalledTimes(1);
    expect(mockClaude.runAI.mock.calls[0][0]).toContain("The CI checks have failed");
    expect(mockClaude.runAI.mock.calls[0][0]).not.toContain("after a deterministic file-overlap check was inconclusive");
    expect(mockClaude.createWorktreeFromBranch).toHaveBeenCalledWith(repo, pr.headRefName, "ci-fixer");
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("overlapping changed root file — skips AI classification and proceeds with fix", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("npm ERR! package.json failed validation");
    mockGh.getPRChangedFiles.mockResolvedValue(["package.json"]);
    mockClaude.runAI.mockResolvedValueOnce("fixed");

    await run([repo]);

    expect(mockClaude.runAI).toHaveBeenCalledTimes(1);
    expect(mockClaude.runAI.mock.calls[0][0]).not.toContain("after a deterministic file-overlap check was inconclusive");
    expect(mockClaude.createWorktreeFromBranch).toHaveBeenCalledWith(repo, pr.headRefName, "ci-fixer");
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("unrelated failure — files issue, does not attempt fix", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: flakey timeout");
    // Classification returns unrelated
    mockClaude.runAI.mockResolvedValueOnce(
      '{"related": false, "reason": "intermittent timeout unrelated to PR"}',
    );

    await run([repo]);

    // Should file an issue with stable body
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      repo.fullName,
      "[ci-unrelated] CI failures unrelated to PR changes",
      expect.stringContaining("Auto-created by Yeti"),
      [],
    );
    // Fingerprint logged as comment with run link
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      99,
      expect.stringContaining("### ci"),
    );
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      99,
      expect.stringContaining("https://github.com/org/repo/actions/runs/123"),
    );
    // Should NOT create a worktree for fixing (merge-base worktree is fine)
    expect(mockClaude.createWorktreeFromBranch).not.toHaveBeenCalledWith(
      repo,
      pr.headRefName,
      "ci-fixer",
    );
  });

  it("inconclusive overlap with valid unrelated JSON — files issue with derived fingerprint", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI / Unit",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("FAIL tests/auth.test.ts\nError: timeout");
    mockGh.getPRChangedFiles.mockResolvedValue(["src/app.ts"]);
    mockClaude.runAI.mockResolvedValueOnce('{"related": false, "reason": "flaky timeout"}');

    await run([repo]);

    expect(mockClaude.runAI).toHaveBeenCalledTimes(1);
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      99,
      expect.stringContaining("ci-unit:tests/auth.test.ts"),
    );
  });

  it("unrelated failure — updates existing issue instead of creating duplicate", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: flakey timeout");
    mockClaude.runAI.mockResolvedValueOnce(
      '{"related": false, "reason": "timeout"}',
    );
    // Existing issue found
    mockGh.searchIssues.mockResolvedValue([
      { number: 50, title: "[ci-unrelated] CI failures unrelated to PR changes" },
    ]);

    await run([repo]);

    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      50,
      expect.stringContaining("### ci"),
    );
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      50,
      expect.stringContaining("https://github.com/org/repo/actions/runs/123"),
    );
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("unrelated failures with different fingerprints — all go to same issue", async () => {
    const pr1 = mockPR({ number: 10, title: "PR ten" });
    const pr2 = mockPR({ number: 20, title: "PR twenty" });
    mockGh.listPRs.mockResolvedValue([pr1, pr2]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog
      .mockResolvedValueOnce("FAIL tests/auth.test.ts\nerror: some failure")
      .mockResolvedValueOnce("FAIL tests/api.test.ts\nerror: some failure");
    // Fingerprints are derived from the check name and extracted failing path.
    mockClaude.runAI
      .mockResolvedValueOnce('{"related": false, "reason": "timeout"}')
      .mockResolvedValueOnce('{"related": false, "reason": "disk space"}');
    // Structural grouping: single search, no existing issue
    mockGh.searchIssues.mockResolvedValueOnce([]);
    mockGh.createIssue.mockResolvedValue(99);

    await run([repo]);

    // Single search (structural dedup — grouped by repo before processing)
    expect(mockGh.searchIssues).toHaveBeenCalledTimes(1);
    expect(mockGh.searchIssues).toHaveBeenCalledWith(repo.fullName, "[ci-unrelated] CI failures unrelated to PR changes");
    // One issue created
    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    // Both occurrences logged as comments
    expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(2);
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      99,
      expect.stringContaining("ci:tests/auth.test.ts"),
    );
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      99,
      expect.stringContaining("ci:tests/api.test.ts"),
    );
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      99,
      expect.stringContaining("https://github.com/org/repo/actions/runs/123"),
    );
  });

  it("unrelated failure — reverts recorded ci-fixer commits and excludes human commits without AI", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: flakey timeout");
    // Classification: unrelated
    mockClaude.runAI.mockResolvedValueOnce(
      '{"related": false, "fingerprint": "flakey-test:timeout", "reason": "timeout"}',
    );
    // DB says there are previous ci-fixer tasks
    mockDb.hasPreviousCiFixerTasks.mockReturnValue(true);
    mockDb.getCiFixerFixCommitShas.mockReturnValue(["yeti1", "yeti2"]);
    mockClaude.commitsOnBranch.mockResolvedValue(["human1", "yeti2", "yeti1"]);
    mockClaude.getRevertedShas.mockResolvedValue([]);
    mockClaude.git.mockResolvedValue("0");

    await run([repo]);

    // Should create a worktree for revert
    expect(mockClaude.createWorktreeFromBranch).toHaveBeenCalledWith(
      repo,
      pr.headRefName,
      "ci-fixer-revert",
    );
    expect(mockClaude.revertCommit).toHaveBeenCalledTimes(2);
    expect(mockClaude.revertCommit).toHaveBeenNthCalledWith(1, "/tmp/worktree", "yeti2");
    expect(mockClaude.revertCommit).toHaveBeenNthCalledWith(2, "/tmp/worktree", "yeti1");
    expect(mockClaude.revertCommit).not.toHaveBeenCalledWith("/tmp/worktree", "human1");
    expect(mockClaude.git).not.toHaveBeenCalledWith(
      ["log", "--oneline", `origin/${pr.baseRefName}..HEAD`],
      "/tmp/worktree",
    );
    expect(mockClaude.runAI).toHaveBeenCalledTimes(1);
    expect(mockClaude.pushBranch).toHaveBeenCalled();
  });

  it("unrelated failure — excludes already reverted recorded commits", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: flakey timeout");
    mockClaude.runAI.mockResolvedValueOnce(
      '{"related": false, "fingerprint": "flakey-test:timeout", "reason": "timeout"}',
    );
    mockDb.hasPreviousCiFixerTasks.mockReturnValue(true);
    mockDb.getCiFixerFixCommitShas.mockReturnValue(["yeti1", "yeti2"]);
    mockClaude.commitsOnBranch.mockResolvedValue(["yeti2", "yeti1"]);
    mockClaude.getRevertedShas.mockResolvedValue(["yeti1"]);
    mockClaude.git.mockResolvedValue("0");

    await run([repo]);

    expect(mockClaude.revertCommit).toHaveBeenCalledTimes(1);
    expect(mockClaude.revertCommit).toHaveBeenCalledWith("/tmp/worktree", "yeti2");
  });

  it("unrelated failure — conflict during deterministic revert falls back to AI with explicit SHAs", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: flakey timeout");
    mockClaude.runAI
      .mockResolvedValueOnce('{"related": false, "fingerprint": "flakey-test:timeout", "reason": "timeout"}')
      .mockResolvedValueOnce("resolved revert conflict");
    mockDb.hasPreviousCiFixerTasks.mockReturnValue(true);
    mockDb.getCiFixerFixCommitShas.mockReturnValue(["yeti1", "yeti2"]);
    mockClaude.commitsOnBranch.mockResolvedValue(["yeti2", "yeti1"]);
    mockClaude.getRevertedShas.mockResolvedValue([]);
    mockClaude.revertCommit.mockResolvedValueOnce({ clean: false });
    mockClaude.getHeadSha.mockResolvedValue("revert-start");
    mockClaude.git.mockResolvedValue("0");

    await run([repo]);

    expect(mockClaude.abortRevert).toHaveBeenCalledWith("/tmp/worktree");
    expect(mockClaude.resetHard).toHaveBeenCalledWith("/tmp/worktree", "revert-start");
    expect(mockClaude.runAI).toHaveBeenCalledTimes(2);
    const prompt = mockClaude.runAI.mock.calls[1][0] as string;
    expect(prompt).toContain("Revert exactly these commits");
    expect(prompt).toContain("- yeti2");
    expect(prompt).toContain("- yeti1");
  });

  it("unrelated failure — previous tasks without recorded SHAs do not trigger AI inference", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: flakey timeout");
    mockClaude.runAI.mockResolvedValueOnce(
      '{"related": false, "fingerprint": "flakey-test:timeout", "reason": "timeout"}',
    );
    mockDb.hasPreviousCiFixerTasks.mockReturnValue(true);
    mockDb.getCiFixerFixCommitShas.mockReturnValue([]);
    mockClaude.git.mockResolvedValue("0");

    await run([repo]);

    expect(mockClaude.revertCommit).not.toHaveBeenCalled();
    expect(mockClaude.runAI).toHaveBeenCalledTimes(1);
    expect(mockClaude.git).not.toHaveBeenCalledWith(
      ["log", "--oneline", `origin/${pr.baseRefName}..HEAD`],
      "/tmp/worktree",
    );
  });

  it("unrelated failure — no previous ci-fixer tasks, skip revert", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: runner issue");
    mockClaude.runAI.mockResolvedValueOnce(
      '{"related": false, "fingerprint": "runner:disk-space", "reason": "disk space issue"}',
    );
    mockDb.hasPreviousCiFixerTasks.mockReturnValue(false);

    await run([repo]);

    // Issue should still be filed
    expect(mockGh.createIssue).toHaveBeenCalled();
    // No worktree for revert (merge-base worktree is fine)
    expect(mockClaude.createWorktreeFromBranch).not.toHaveBeenCalledWith(
      repo,
      pr.headRefName,
      "ci-fixer-revert",
    );
  });

  it("unrelated failure — merges base branch when behind", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: flakey timeout");
    mockClaude.runAI.mockResolvedValueOnce(
      '{"related": false, "fingerprint": "flakey-test:timeout", "reason": "timeout"}',
    );
    // rev-list returns 3 (behind by 3 commits)
    mockClaude.git.mockResolvedValue("3");
    mockClaude.attemptMerge.mockResolvedValue({ clean: true, conflictedFiles: [] });

    await run([repo]);

    // Should create worktree for merge-base
    expect(mockClaude.createWorktreeFromBranch).toHaveBeenCalledWith(
      repo,
      pr.headRefName,
      "ci-fixer-merge-base",
    );
    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockDb.recordTaskStart).toHaveBeenCalledWith("ci-fixer:merge-base", repo.fullName, pr.number, null);
    expect(mockDb.recordTaskComplete).toHaveBeenCalled();
  });

  it("unrelated failure — skips merge when already up-to-date", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: flakey timeout");
    mockClaude.runAI.mockResolvedValueOnce(
      '{"related": false, "fingerprint": "flakey-test:timeout", "reason": "timeout"}',
    );
    // rev-list returns 0 (already up-to-date)
    mockClaude.git.mockResolvedValue("0");

    await run([repo]);

    expect(mockClaude.attemptMerge).not.toHaveBeenCalled();
    expect(mockClaude.pushBranch).not.toHaveBeenCalled();
  });

  it("unrelated failure — aborts merge when conflicts arise", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: flakey timeout");
    mockClaude.runAI.mockResolvedValueOnce(
      '{"related": false, "fingerprint": "flakey-test:timeout", "reason": "timeout"}',
    );
    // Behind by 2 commits, merge has conflicts
    mockClaude.git.mockResolvedValue("2");
    mockClaude.attemptMerge.mockResolvedValue({ clean: false, conflictedFiles: ["file.ts"] });
    mockClaude.abortMerge.mockResolvedValue(undefined);

    await run([repo]);

    expect(mockClaude.abortMerge).toHaveBeenCalled();
    expect(mockClaude.pushBranch).not.toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).toHaveBeenCalled();
  });

  it("unrelated failure — merge-base error does not block processing", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: flakey timeout");
    mockClaude.runAI.mockResolvedValueOnce(
      '{"related": false, "fingerprint": "flakey-test:timeout", "reason": "timeout"}',
    );
    // createWorktreeFromBranch fails for merge-base
    mockClaude.createWorktreeFromBranch.mockRejectedValue(new Error("worktree error"));

    // Should not throw
    await run([repo]);

    // Issue was still filed
    expect(mockGh.createIssue).toHaveBeenCalled();
    // Task recorded as failed
    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("worktree error"));
  });

  it("classification fails to parse — defaults to related", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: test failed");
    // Claude returns malformed output for classification, then valid fix
    mockClaude.runAI
      .mockResolvedValueOnce("I cannot determine the issue, here is some random text")
      .mockResolvedValueOnce("fixed");

    await run([repo]);

    // Should proceed with fix (default to related)
    expect(mockLog.warn).toHaveBeenCalledWith("[ci-fixer] Unparseable classification response; defaulting to related");
    expect(mockClaude.createWorktreeFromBranch).toHaveBeenCalledWith(repo, pr.headRefName, "ci-fixer");
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("getPRChangedFiles fails — defaults to related", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: test failed");
    // Changed files returns empty (failure case)
    mockGh.getPRChangedFiles.mockResolvedValue([]);
    // Classification still returns related with empty files
    mockClaude.runAI
      .mockResolvedValueOnce('{"related": true, "fingerprint": "", "reason": "related"}')
      .mockResolvedValueOnce("fixed");

    await run([repo]);

    expect(mockClaude.createWorktreeFromBranch).toHaveBeenCalledWith(repo, pr.headRefName, "ci-fixer");
  });

  it("issue filing fails — does not block processing", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: flakey test");
    mockClaude.runAI.mockResolvedValueOnce(
      '{"related": false, "fingerprint": "flakey-test:timeout", "reason": "timeout"}',
    );
    // Issue creation fails
    mockGh.createIssue.mockRejectedValue(new Error("API error"));

    // Should not throw
    await run([repo]);

    // Processing completed despite issue filing failure
    expect(mockGh.createIssue).toHaveBeenCalled();
  });

  it("no failure logs — re-runs workflow when run link exists", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.prChecksPassing.mockResolvedValue(false);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("");

    await run([repo]);

    expect(mockGh.rerunWorkflow).toHaveBeenCalledWith(repo.fullName, "123");
    expect(mockClaude.createWorktreeFromBranch).not.toHaveBeenCalled();
  });

  it("no failure logs and no run link — does not create worktree", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.prChecksPassing.mockResolvedValue(false);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "",
    });
    mockGh.getFailedRunLog.mockResolvedValue("");

    await run([repo]);

    expect(mockGh.rerunWorkflow).not.toHaveBeenCalled();
    expect(mockClaude.createWorktreeFromBranch).not.toHaveBeenCalled();
  });

  it("no failing checks — returns early", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.prChecksPassing.mockResolvedValue(false);
    mockGh.getFailingCheck.mockResolvedValue(undefined);

    await run([repo]);

    expect(mockClaude.createWorktreeFromBranch).not.toHaveBeenCalled();
  });

  it("no commits produced — no push and no description update", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: test failed");
    mockClaude.runAI
      .mockResolvedValueOnce('{"related": true, "fingerprint": "", "reason": "related"}')
      .mockResolvedValueOnce("fixed");
    mockClaude.hasNewCommits.mockResolvedValue(false);

    await run([repo]);

    expect(mockClaude.pushBranch).not.toHaveBeenCalled();
    expect(mockClaude.regeneratePRDescription).not.toHaveBeenCalled();
    expect(mockGh.updatePRBody).not.toHaveBeenCalled();
    expect(mockDb.recordTaskCommits).not.toHaveBeenCalled();
  });

  it("conflict resolution — updates PR description after Claude-resolved push", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRMergeableState.mockResolvedValue("CONFLICTING");
    mockClaude.attemptMerge = vi.fn().mockResolvedValue({ clean: false, conflictedFiles: ["file.ts"] });
    mockClaude.abortMerge = vi.fn().mockResolvedValue(undefined);

    await run([repo]);

    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockClaude.regeneratePRDescription).toHaveBeenCalledWith("/tmp/worktree", pr.baseRefName, pr, undefined);
    expect(mockGh.updatePRBody).toHaveBeenCalledWith(repo.fullName, pr.number, "## Summary\nUpdated");
    expect(mockEnforceLearnings).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      jobName: "ci-fixer",
      repo: repo.fullName,
      wtPath: "/tmp/worktree",
      baseBranch: pr.headRefName,
      mergeBase: pr.baseRefName,
    }));
  });

  it("clean merge conflict — does NOT update PR description", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRMergeableState.mockResolvedValue("CONFLICTING");
    mockClaude.attemptMerge = vi.fn().mockResolvedValue({ clean: true, conflictedFiles: [] });

    await run([repo]);

    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockClaude.regeneratePRDescription).not.toHaveBeenCalled();
    expect(mockGh.updatePRBody).not.toHaveBeenCalled();
  });

  it("description update failure — does not fail the task", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: test failed");
    mockClaude.runAI
      .mockResolvedValueOnce('{"related": true, "fingerprint": "", "reason": "related"}')
      .mockResolvedValueOnce("fixed");
    mockClaude.regeneratePRDescription.mockRejectedValue(new Error("Claude unavailable"));

    await run([repo]);

    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
    // Task completed despite description failure
    expect(mockDb.recordTaskFailed).not.toHaveBeenCalled();
  });

  it("error during fix — records task as failed and reports error for regular PR", async () => {
    const pr = mockPR();
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.prChecksPassing.mockResolvedValue(false);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("log output");
    // Classification returns related, then fix Claude call fails
    mockClaude.runAI
      .mockResolvedValueOnce('{"related": true, "fingerprint": "", "reason": "related"}')
      .mockRejectedValueOnce(new Error("claude error"));

    await run([repo]);

    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("claude error"));
    expect(mockClaude.removeWorktree).toHaveBeenCalled();
    expect(mockReportError).toHaveBeenCalledWith(
      "ci-fixer:process-pr",
      `${repo.fullName}#${pr.number}`,
      expect.any(Error),
    );
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("error on ci-unrelated fix PR — comments on PR instead of reportError", async () => {
    const pr = mockPR({
      title: "fix: resolve #42 — [ci-unrelated] CI failures unrelated to PR changes",
    });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("log output");
    // Classification is skipped for ci-unrelated fix PRs, so only the fix call matters
    mockClaude.runAI.mockRejectedValueOnce(new Error("claude error"));

    await run([repo]);

    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      expect.stringContaining("### CI Fixer Error"),
    );
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      pr.number,
      expect.stringContaining("claude error"),
    );
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it("error on ci-unrelated fix PR — edits existing error comment", async () => {
    const pr = mockPR({
      title: "fix: resolve #42 — [ci-unrelated] CI failures unrelated to PR changes",
    });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("log output");
    // Classification is skipped for ci-unrelated fix PRs
    mockClaude.runAI.mockRejectedValueOnce(new Error("claude error"));
    // Existing error comment from Yeti
    mockGh.getIssueComments.mockResolvedValue([
      { id: 777, body: "### CI Fixer Error\n\nprevious error", login: "yeti-bot" },
    ]);
    mockGh.isYetiComment.mockReturnValue(true);

    await run([repo]);

    expect(mockGh.editIssueComment).toHaveBeenCalledWith(
      repo.fullName,
      777,
      expect.stringContaining("### CI Fixer Error"),
    );
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockReportError).not.toHaveBeenCalled();
  });

  it("ShutdownError — does not comment on PR or report error", async () => {
    const pr = mockPR({
      title: "fix: resolve #42 — [ci-unrelated] CI failures unrelated to PR changes",
    });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("log output");
    // Classification is skipped for ci-unrelated fix PRs
    mockClaude.runAI.mockRejectedValueOnce(new ShutdownError("shutting down"));

    await run([repo]);

    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockReportError).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.stringContaining("Shutdown"),
    );
  });

  it("RateLimitError — does not comment on PR or report error", async () => {
    const pr = mockPR({
      title: "fix: resolve #42 — [ci-unrelated] CI failures unrelated to PR changes",
    });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getPRMergeableState.mockResolvedValue("MERGEABLE");
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("log output");
    // Classification is skipped for ci-unrelated fix PRs
    mockClaude.runAI.mockRejectedValueOnce(new MockRateLimitError("rate limited"));

    await run([repo]);

    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockReportError).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("Rate limited"),
    );
  });

  it("error comment posting fails on ci-unrelated PR — does not throw", async () => {
    const pr = mockPR({
      title: "fix: resolve #42 — [ci-unrelated] CI failures unrelated to PR changes",
    });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("log output");
    // Classification is skipped for ci-unrelated fix PRs
    mockClaude.runAI.mockRejectedValueOnce(new Error("claude error"));
    // Commenting itself fails
    mockGh.getIssueComments.mockRejectedValue(new Error("API error"));

    // Should not throw
    await run([repo]);

    expect(mockReportError).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to post error comment"),
    );
  });

  it("ci-unrelated fix PR — skips classification and attempts fix directly", async () => {
    const pr = mockPR({
      title: "fix: resolve #42 — [ci-unrelated] CI failures unrelated to PR changes",
    });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: test failed");
    // Only one runClaude call — for the fix, not classification
    mockClaude.runAI.mockResolvedValueOnce("fixed the issue");

    await run([repo]);

    // Classification should be skipped
    expect(mockGh.getPRChangedFiles).not.toHaveBeenCalled();
    // Fix should be attempted
    expect(mockClaude.createWorktreeFromBranch).toHaveBeenCalledWith(repo, pr.headRefName, "ci-fixer");
    expect(mockClaude.pushBranch).toHaveBeenCalled();
    // No issue filing
    expect(mockGh.searchIssues).not.toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("regular PR still classifies normally when ci-unrelated guard is present", async () => {
    const pr = mockPR({ title: "feat: add new feature" });
    mockGh.listPRs.mockResolvedValue([pr]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: flakey timeout");
    mockClaude.runAI.mockResolvedValueOnce(
      '{"related": false, "fingerprint": "flakey-test:timeout", "reason": "timeout"}',
    );

    await run([repo]);

    // Classification should run for regular PRs
    expect(mockGh.getPRChangedFiles).toHaveBeenCalledWith(repo.fullName, pr.number);
    // Unrelated path should be taken
    expect(mockGh.createIssue).toHaveBeenCalled();
    // Fix should NOT be attempted
    expect(mockClaude.createWorktreeFromBranch).not.toHaveBeenCalledWith(
      repo,
      pr.headRefName,
      "ci-fixer",
    );
  });

  it("concurrent unrelated failures from same repo — single search, single create", async () => {
    const pr1 = mockPR({ number: 10, title: "PR ten" });
    const pr2 = mockPR({ number: 20, title: "PR twenty" });
    const pr3 = mockPR({ number: 30, title: "PR thirty" });
    mockGh.listPRs.mockResolvedValue([pr1, pr2, pr3]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: some failure");
    mockClaude.runAI
      .mockResolvedValueOnce('{"related": false, "fingerprint": "flakey-test:timeout", "reason": "timeout"}')
      .mockResolvedValueOnce('{"related": false, "fingerprint": "runner:disk-space", "reason": "disk space"}')
      .mockResolvedValueOnce('{"related": false, "fingerprint": "flakey-test:auth", "reason": "auth flake"}');
    mockGh.searchIssues.mockResolvedValueOnce([]);
    mockGh.createIssue.mockResolvedValue(99);

    await run([repo]);

    // Structural dedup: one search, one create, three comments
    expect(mockGh.searchIssues).toHaveBeenCalledTimes(1);
    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(3);
  });

  it("unrelated failures across different repos — separate issues", async () => {
    const repo2 = mockRepo({ fullName: "org/other-repo" });
    const pr1 = mockPR({ number: 10, title: "PR ten" });
    const pr2 = mockPR({ number: 20, title: "PR twenty" });
    mockGh.listPRs
      .mockResolvedValueOnce([pr1])
      .mockResolvedValueOnce([pr2]);
    mockGh.getFailingCheck.mockResolvedValue({
      name: "CI",
      state: "FAILURE",
      link: "https://github.com/org/repo/actions/runs/123",
    });
    mockGh.getFailedRunLog.mockResolvedValue("error: some failure");
    mockClaude.runAI
      .mockResolvedValueOnce('{"related": false, "fingerprint": "flakey-test:timeout", "reason": "timeout"}')
      .mockResolvedValueOnce('{"related": false, "fingerprint": "runner:disk-space", "reason": "disk space"}');
    // Each repo's search returns empty
    mockGh.searchIssues.mockResolvedValue([]);
    mockGh.createIssue
      .mockResolvedValueOnce(99)
      .mockResolvedValueOnce(100);

    await run([repo, repo2]);

    // One search per repo, one create per repo
    expect(mockGh.searchIssues).toHaveBeenCalledTimes(2);
    expect(mockGh.createIssue).toHaveBeenCalledTimes(2);
    // One comment per occurrence
    expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(2);
  });
});

describe("buildConflictPrompt (policy template)", () => {
  // Reconstructs the pre-migration inline prompt independently, proving the
  // policy-template render is behavior-preserving.
  function expected(fullName: string, pr: gh.PR, conflictedFiles: string[]): string {
    return [
      `You are resolving merge conflicts on a pull request in the repository ${fullName}.`,
      `PR #${pr.number}: ${pr.title}`,
      `Branch: ${pr.headRefName} (merging ${pr.baseRefName} into it)`,
      ``,
      `A merge of the base branch (origin/${pr.baseRefName}) has been started but has`,
      `conflicts in the following files:`,
      conflictedFiles.map((f) => `- ${f}`).join("\n"),
      ``,
      `The conflicted files contain standard git conflict markers`,
      `(<<<<<<< HEAD, =======, >>>>>>>).`,
      ``,
      `Please resolve each conflict by:`,
      `1. Reading each conflicted file`,
      `2. Understanding the intent of both sides of the conflict`,
      `3. Editing the file to remove all conflict markers and produce the correct merged result`,
      `4. Staging the resolved files with \`git add <file>\``,
      `5. Completing the merge with \`git commit --no-edit\``,
    ].join("\n");
  }

  it("matches the pre-migration inline builder", () => {
    const pr = mockPR({ number: 42, title: "Add dark mode", headRefName: "feature", baseRefName: "main" });
    const conflictedFiles = ["src/a.ts", "src/b.ts"];
    const out = buildConflictPrompt("pr", "acme/widget", pr, conflictedFiles);
    expect(stripPreamble(out).trimEnd()).toBe(expected("acme/widget", pr, conflictedFiles).trimEnd());
  });
});

describe("buildClassifyPrompt (policy template)", () => {
  function expected(pr: gh.PR, failLog: string, changedFiles: string[]): string {
    return [
      `You are classifying a CI failure after a deterministic file-overlap check was inconclusive.`,
      `Decide only whether this is flaky / runner-infra / pre-existing on the base branch versus a genuine failure caused by this pull request.`,
      ``,
      `PR #${pr.number}: ${pr.title}`,
      `Branch: ${pr.headRefName}`,
      ``,
      `Files changed in this PR:`,
      changedFiles.map((f) => `- ${f}`).join("\n"),
      ``,
      `CI failure log:`,
      "```",
      failLog,
      "```",
      ``,
      `Classify this failure. Respond with ONLY a JSON object (no markdown, no explanation):`,
      `{`,
      `  "related": true/false,`,
      `  "reason": "1-2 sentence explanation"`,
      `}`,
      ``,
      `Classification rules:`,
      `- "related": true if this appears to be a genuine failure caused by this PR`,
      `  - Test failures exercising behavior the PR changed → related`,
      `  - Build errors caused by the PR's changes → related`,
      `- "related": false if the failure is NOT caused by the PR`,
      `  - Flakey tests (timeouts, race conditions, intermittent failures) → unrelated`,
      `  - CI runner issues (disk space, network, docker pull limits) → unrelated`,
      `  - Pre-existing failures that exist on the base branch → unrelated`,
      `- When in doubt, classify as related (safe default)`,
      ``,
      `- "reason": brief explanation of why you classified it this way`,
    ].join("\n");
  }

  it("matches the pre-migration inline builder", () => {
    const pr = mockPR({ number: 7, title: "Fix bug", headRefName: "fix-branch" });
    const failLog = "error: test failed\nAssertionError: expected true to be false";
    const changedFiles = ["src/app.ts", "src/util.ts"];
    const out = buildClassifyPrompt("pr", pr, failLog, changedFiles);
    expect(stripPreamble(out).trimEnd()).toBe(expected(pr, failLog, changedFiles).trimEnd());
  });
});

describe("buildFixPrompt (policy template)", () => {
  function expected(fullName: string, pr: gh.PR, failLog: string): string {
    return [
      `You are fixing a CI failure on a pull request in the repository ${fullName}.`,
      `PR #${pr.number}: ${pr.title}`,
      `Branch: ${pr.headRefName}`,
      ``,
      `The CI checks have failed. Here are the relevant failure logs:`,
      ``,
      "```",
      failLog,
      "```",
      ``,
      `Please analyze the failure and make the necessary code changes to fix it.`,
      `Make commits with clear messages as you work.`,
    ].join("\n");
  }

  it("matches the pre-migration inline builder", () => {
    const pr = mockPR({ number: 15, title: "Add feature", headRefName: "feature-branch" });
    const failLog = "npm ERR! Test failed";
    const out = buildFixPrompt("pr", "acme/widget", pr, failLog);
    expect(stripPreamble(out).trimEnd()).toBe(expected("acme/widget", pr, failLog).trimEnd());
  });
});

describe("buildRevertPrompt (policy template)", () => {
  function expected(pr: gh.PR, changedFiles: string[], shas: string[]): string {
    return [
      `You are resolving conflicts while reverting Yeti ci-fixer commits on a pull request branch.`,
      ``,
      `PR #${pr.number}: ${pr.title}`,
      `Branch: ${pr.headRefName}`,
      ``,
      `Files originally changed in this PR:`,
      changedFiles.map((f) => `- ${f}`).join("\n"),
      ``,
      `Revert exactly these commits, newest first:`,
      shas.map((sha) => `- ${sha}`).join("\n"),
      ``,
      `Run \`git revert <sha> --no-edit\` for the listed commits only. If conflicts occur, resolve them while preserving the PR's intended changes to the files listed above.`,
      ``,
      `Do not revert, reset, amend, squash, or otherwise modify any other commit. If a listed commit is already reverted, leave it alone and continue with the remaining listed commits.`,
    ].join("\n");
  }

  it("renders the explicit SHA list without log-inference instructions", () => {
    const pr = mockPR({ number: 23, title: "Add widget", headRefName: "widget-branch" });
    const changedFiles = ["src/widget.ts"];
    const shas = ["abc123", "def456"];
    const out = buildRevertPrompt("pr", pr, changedFiles, shas);
    expect(stripPreamble(out).trimEnd()).toBe(expected(pr, changedFiles, shas).trimEnd());
    expect(out).not.toContain("Commit history");
    expect(out).not.toContain("Identify any commits");
  });
});
