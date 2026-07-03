import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  SELF_REPO: "test-org/yeti",
  JOB_AI: {},
  WORK_DIR: "/tmp/yeti-lc-test",
  repoAutonomy: () => "pr",
}));
vi.mock("../log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../error-reporter.js", () => ({ reportError: vi.fn() }));
vi.mock("../capability.js", () => ({ can: vi.fn().mockReturnValue(true) }));
const mockNotify = vi.hoisted(() => vi.fn());
vi.mock("../notify.js", () => ({ notify: mockNotify }));

const { mockGh, mockClaude, mockDb } = vi.hoisted(() => ({
  mockGh: {
    listPRs: vi.fn(),
    createPR: vi.fn(),
    pullUrl: (fullName: string, number: number) => `https://github.com/${fullName}/pull/${number}`,
  },
  mockClaude: {
    createWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    enqueue: vi.fn(),
    resolveEnqueue: vi.fn(),
    runAI: vi.fn(),
    hasNewCommits: vi.fn(),
    hasTreeDiff: vi.fn(),
    pushBranch: vi.fn(),
    deleteRemoteBranch: vi.fn(),
    randomSuffix: vi.fn().mockReturnValue("ab12"),
    datestamp: vi.fn().mockReturnValue("20260702"),
  },
  mockDb: {
    getPendingLearnings: vi.fn(),
    markLearningsConsolidated: vi.fn(),
    dismissLearning: vi.fn(),
    recordTaskStart: vi.fn().mockReturnValue(1),
    updateTaskWorktree: vi.fn(),
    recordTaskComplete: vi.fn(),
    recordTaskFailed: vi.fn(),
  },
}));
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);

import { run, parseDismissals, buildPRBody, formatLearnings } from "./learning-consolidator.js";

const learning = (id: number, summary: string) => ({
  id, job_name: "issue-worker", repo: "test-org/app", kind: "yeti",
  summary, status: "pending", reason: null, pr_number: null, created_at: "2026-07-01 00:00:00",
});

describe("learning-consolidator", () => {
  const selfRepo = mockRepo({ owner: "test-org", name: "yeti", fullName: "test-org/yeti" });

  beforeEach(() => {
    vi.clearAllMocks();
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.resolveEnqueue.mockReturnValue(mockClaude.enqueue);
    mockClaude.createWorktree.mockResolvedValue("/tmp/wt");
    mockClaude.removeWorktree.mockResolvedValue(undefined);
    mockClaude.runAI.mockResolvedValue("consolidated everything");
    mockClaude.hasNewCommits.mockResolvedValue(true);
    mockClaude.hasTreeDiff.mockResolvedValue(true);
    mockClaude.pushBranch.mockResolvedValue(undefined);
    mockClaude.deleteRemoteBranch.mockResolvedValue(undefined);
    mockGh.listPRs.mockResolvedValue([]);
    mockGh.createPR.mockResolvedValue(77);
    mockDb.getPendingLearnings.mockReturnValue([learning(1, "use brew"), learning(2, "gh needs --head")]);
  });

  it("no pending learnings → does nothing", async () => {
    mockDb.getPendingLearnings.mockReturnValue([]);
    await run([selfRepo]);
    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
  });

  it("skips when SELF_REPO is not in the repo list", async () => {
    await run([mockRepo()]);
    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
  });

  it("skips when an open learnings PR already exists (fresh list)", async () => {
    mockGh.listPRs.mockResolvedValue([{ headRefName: "yeti/learnings-20260701-xx", number: 5, title: "", baseRefName: "main", labels: [], author: { login: "yeti" }, body: "" }]);
    await run([selfRepo]);
    expect(mockGh.listPRs).toHaveBeenCalledWith("test-org/yeti", { fresh: true });
    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
  });

  it("happy path — runs AI, pushes, creates PR, marks consolidated", async () => {
    await run([selfRepo]);
    expect(mockClaude.runAI).toHaveBeenCalled();
    expect(mockGh.createPR).toHaveBeenCalledWith(
      "test-org/yeti",
      "yeti/learnings-20260702-ab12",
      expect.stringContaining("2 environment learning"),
      expect.stringContaining("use brew"),
    );
    expect(mockDb.markLearningsConsolidated).toHaveBeenCalledWith([1, 2], 77);
    expect(mockDb.recordTaskComplete).toHaveBeenCalled();
    expect(mockClaude.deleteRemoteBranch).not.toHaveBeenCalled();
  });

  it("createPR failure after push deletes the orphaned branch and leaves learnings pending", async () => {
    mockGh.createPR.mockRejectedValue(new Error("pr boom"));

    await run([selfRepo]);

    expect(mockClaude.pushBranch).toHaveBeenCalledWith("/tmp/wt", "yeti/learnings-20260702-ab12", "test-org/yeti");
    expect(mockClaude.deleteRemoteBranch).toHaveBeenCalledWith("/tmp/wt", "yeti/learnings-20260702-ab12", "test-org/yeti");
    expect(mockDb.markLearningsConsolidated).not.toHaveBeenCalled();
    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, "Error: pr boom");
    expect(mockClaude.removeWorktree).toHaveBeenCalledWith(selfRepo, "/tmp/wt");
  });

  it("push failure does not attempt remote branch deletion", async () => {
    mockClaude.pushBranch.mockRejectedValue(new Error("push boom"));

    await run([selfRepo]);

    expect(mockGh.createPR).not.toHaveBeenCalled();
    expect(mockClaude.deleteRemoteBranch).not.toHaveBeenCalled();
    expect(mockDb.markLearningsConsolidated).not.toHaveBeenCalled();
    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, "Error: push boom");
  });

  it("remote branch deletion failure after createPR failure is swallowed", async () => {
    mockGh.createPR.mockRejectedValue(new Error("pr boom"));
    mockClaude.deleteRemoteBranch.mockRejectedValue(new Error("delete boom"));

    await run([selfRepo]);

    expect(mockClaude.deleteRemoteBranch).toHaveBeenCalledWith("/tmp/wt", "yeti/learnings-20260702-ab12", "test-org/yeti");
    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, "Error: pr boom");
    expect(mockDb.markLearningsConsolidated).not.toHaveBeenCalled();
  });

  it("failure after createPR succeeds does not delete the PR branch", async () => {
    mockDb.markLearningsConsolidated.mockImplementation(() => {
      throw new Error("db boom");
    });

    await run([selfRepo]);

    expect(mockGh.createPR).toHaveBeenCalled();
    expect(mockClaude.deleteRemoteBranch).not.toHaveBeenCalled();
    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, "Error: db boom");
  });

  it("dismissals from output are applied and excluded from the PR set", async () => {
    mockClaude.runAI.mockResolvedValue("done\nDISMISSED: 2: already covered by preamble");
    await run([selfRepo]);
    expect(mockDb.dismissLearning).toHaveBeenCalledWith(2, "already covered by preamble");
    expect(mockDb.markLearningsConsolidated).toHaveBeenCalledWith([1], 77);
  });

  it("all dismissed → no PR", async () => {
    mockClaude.runAI.mockResolvedValue("DISMISSED: 1: vague\nDISMISSED: 2: vague");
    await run([selfRepo]);
    expect(mockGh.createPR).not.toHaveBeenCalled();
    expect(mockDb.markLearningsConsolidated).not.toHaveBeenCalled();
  });

  it("no tree diff → leaves learnings pending, no PR", async () => {
    mockClaude.hasTreeDiff.mockResolvedValue(false);
    await run([selfRepo]);
    expect(mockGh.createPR).not.toHaveBeenCalled();
    expect(mockDb.markLearningsConsolidated).not.toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).toHaveBeenCalled();
  });

  it("AI failure → task failed, worktree cleaned, no throw", async () => {
    mockClaude.runAI.mockRejectedValue(new Error("boom"));
    await run([selfRepo]);
    expect(mockDb.recordTaskFailed).toHaveBeenCalled();
    expect(mockClaude.removeWorktree).toHaveBeenCalled();
  });
});

describe("parseDismissals", () => {
  it("parses id and reason lines, ignoring other text", () => {
    expect(parseDismissals("blah\nDISMISSED: 3: too vague\nDISMISSED: 10: wrong")).toEqual([
      { id: 3, reason: "too vague" },
      { id: 10, reason: "wrong" },
    ]);
  });
  it("returns empty for output with no dismissals", () => {
    expect(parseDismissals("all folded in")).toEqual([]);
  });

  it("parses case-insensitive DISMISSED prefix", () => {
    expect(parseDismissals("dismissed: 3: lower\nDismissed: 5: mixed\nDISMISSED: 7: upper")).toEqual([
      { id: 3, reason: "lower" },
      { id: 5, reason: "mixed" },
      { id: 7, reason: "upper" },
    ]);
  });
});

describe("formatLearnings", () => {
  it("renders one bullet per learning with its id", () => {
    const text = formatLearnings([learning(7, "use brew")]);
    expect(text).toContain("[7]");
    expect(text).toContain("use brew");
  });
});

describe("buildPRBody", () => {
  it("renders folded-in learnings", () => {
    const text = buildPRBody([learning(1, "use brew"), learning(2, "gh needs --head")], []);

    expect(text).toContain("## Learnings folded in");
    expect(text).toContain("- use brew _(via issue-worker on test-org/app)_");
    expect(text).toContain("- gh needs --head _(via issue-worker on test-org/app)_");
    expect(text).not.toContain("## Dismissed");
  });

  it("includes a Dismissed section when dismissals are present", () => {
    const text = buildPRBody([learning(1, "use brew")], [{ id: 2, reason: "already covered" }]);

    expect(text).toContain("## Dismissed");
    expect(text).toContain("- [2] already covered");
  });
});
