import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./config.js", () => ({
  LEARNINGS_PENDING_THRESHOLD: 5,
}));
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

const { mockClaude, mockDb } = vi.hoisted(() => ({
  mockClaude: {
    runAI: vi.fn(),
    resolveEnqueue: vi.fn(),
    enqueue: vi.fn(),
    hasTreeDiff: vi.fn(),
  },
  mockDb: {
    insertLearning: vi.fn().mockReturnValue(1),
    countPendingLearnings: vi.fn().mockReturnValue(0),
  },
}));
vi.mock("./claude.js", () => mockClaude);
vi.mock("./db.js", () => mockDb);

import { parseLearnings, stripLearningsDeclaration, enforceLearnings, setConsolidatorTrigger } from "./learnings.js";
import * as log from "./log.js";

describe("parseLearnings", () => {
  it("parses none/none as declared with no learnings", () => {
    const out = "did the work\n\nLEARNINGS-REPO: none\nLEARNINGS-YETI: none\n";
    expect(parseLearnings(out)).toEqual({ declared: true, repo: [], yeti: [] });
  });

  it("parses a repo learning with path and summary", () => {
    const out = "LEARNINGS-REPO: yeti/learnings/vite-proxy.md: dev proxy needs /webhooks too\nLEARNINGS-YETI: none";
    expect(parseLearnings(out)).toEqual({
      declared: true,
      repo: [{ path: "yeti/learnings/vite-proxy.md", summary: "dev proxy needs /webhooks too" }],
      yeti: [],
    });
  });

  it("parses a yeti learning and multiple repo lines", () => {
    const out = [
      "LEARNINGS-REPO: yeti/learnings/a.md: first",
      "LEARNINGS-REPO: yeti/learnings/b.md: second",
      "LEARNINGS-YETI: gh pr create needs --head with detached worktrees",
    ].join("\n");
    const parsed = parseLearnings(out);
    expect(parsed.repo).toHaveLength(2);
    expect(parsed.yeti).toEqual(["gh pr create needs --head with detached worktrees"]);
  });

  it("returns declared=false when no declaration lines exist", () => {
    expect(parseLearnings("just some output")).toEqual({ declared: false, repo: [], yeti: [] });
  });

  it("is case-insensitive on 'none' and tolerates leading whitespace", () => {
    const out = "  LEARNINGS-REPO: NONE\n  LEARNINGS-YETI: None";
    expect(parseLearnings(out)).toEqual({ declared: true, repo: [], yeti: [] });
  });

  it("ignores a malformed repo value (no .md path) without throwing", () => {
    const out = "LEARNINGS-REPO: something vague\nLEARNINGS-YETI: none";
    const parsed = parseLearnings(out);
    expect(parsed.declared).toBe(true);
    expect(parsed.repo).toEqual([]);
  });
});

describe("stripLearningsDeclaration", () => {
  it("removes declaration lines and collapses blank runs", () => {
    const out = "## Plan\n\ndetails\n\nLEARNINGS-REPO: none\nLEARNINGS-YETI: none";
    expect(stripLearningsDeclaration(out)).toBe("## Plan\n\ndetails");
  });

  it("returns output unchanged when there is no declaration", () => {
    expect(stripLearningsDeclaration("plain output")).toBe("plain output");
  });

  it("preserves fenced code block blank lines byte-identically when there is no declaration", () => {
    const out = "Here is the diff:\n\n```\nline1\n\n\n\nline2\n```\n";
    expect(stripLearningsDeclaration(out)).toBe(out);
  });

  it("preserves fenced code block blank lines when removing trailing declarations", () => {
    const out = "Here is the diff:\n\n```\nline1\n\n\n\nline2\n```\n\nLEARNINGS-REPO: none\nLEARNINGS-YETI: none\n";
    expect(stripLearningsDeclaration(out)).toBe("Here is the diff:\n\n```\nline1\n\n\n\nline2\n```");
  });
});

describe("enforceLearnings", () => {
  const ctx = { jobName: "issue-worker", repo: "org/repo", wtPath: "/tmp/wt", baseBranch: "main" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.resolveEnqueue.mockReturnValue(mockClaude.enqueue);
    mockClaude.runAI.mockResolvedValue("LEARNINGS-REPO: none\nLEARNINGS-YETI: none");
    mockClaude.hasTreeDiff.mockResolvedValue(true);
    mockDb.insertLearning.mockReturnValue(1);
    mockDb.countPendingLearnings.mockReturnValue(0);
    setConsolidatorTrigger(null as unknown as () => void);
  });

  it("declaration present with none/none → no retry, no inserts", async () => {
    await enforceLearnings("done\nLEARNINGS-REPO: none\nLEARNINGS-YETI: none", ctx);
    expect(mockClaude.runAI).not.toHaveBeenCalled();
    expect(mockDb.insertLearning).not.toHaveBeenCalled();
  });

  it("yeti learning → inserted into db", async () => {
    await enforceLearnings("LEARNINGS-REPO: none\nLEARNINGS-YETI: use brew", ctx);
    expect(mockDb.insertLearning).toHaveBeenCalledWith("issue-worker", "org/repo", "yeti", "use brew");
  });

  it("caps environment learnings to five lines per run", async () => {
    const lines = Array.from(
      { length: 7 },
      (_, i) => `LEARNINGS-YETI: learning ${i + 1}`,
    );
    await enforceLearnings(["LEARNINGS-REPO: none", ...lines].join("\n"), ctx);
    expect(mockDb.insertLearning).toHaveBeenCalledTimes(5);
    expect(mockDb.insertLearning).toHaveBeenLastCalledWith(
      "issue-worker",
      "org/repo",
      "yeti",
      "learning 5",
    );
  });

  it("missing declaration → retries once and captures the retry's learnings", async () => {
    mockClaude.runAI.mockResolvedValueOnce("LEARNINGS-REPO: none\nLEARNINGS-YETI: retry learning");
    await enforceLearnings("no declaration here", ctx);
    expect(mockClaude.runAI).toHaveBeenCalledTimes(1);
    expect(mockDb.insertLearning).toHaveBeenCalledWith("issue-worker", "org/repo", "yeti", "retry learning");
  });

  it("still missing after retry → warns and returns without throwing", async () => {
    mockClaude.runAI.mockResolvedValueOnce("still nothing");
    await enforceLearnings("no declaration", ctx);
    expect(mockDb.insertLearning).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it("repo learning claimed but no yeti/ tree diff → warns, does not throw", async () => {
    mockClaude.hasTreeDiff.mockResolvedValue(false);
    await enforceLearnings("LEARNINGS-REPO: yeti/learnings/x.md: claimed\nLEARNINGS-YETI: none", ctx);
    expect(mockClaude.hasTreeDiff).toHaveBeenCalledWith("/tmp/wt", "main", "yeti/");
    expect(log.warn).toHaveBeenCalled();
  });

  it("threshold reached → fires the consolidator trigger", async () => {
    const trigger = vi.fn();
    setConsolidatorTrigger(trigger);
    mockDb.countPendingLearnings.mockReturnValueOnce(4).mockReturnValueOnce(5);
    await enforceLearnings("LEARNINGS-REPO: none\nLEARNINGS-YETI: hit threshold", ctx);
    expect(trigger).toHaveBeenCalled();
  });

  it("below threshold → trigger not fired", async () => {
    const trigger = vi.fn();
    setConsolidatorTrigger(trigger);
    mockDb.countPendingLearnings.mockReturnValueOnce(3).mockReturnValueOnce(4);
    await enforceLearnings("LEARNINGS-REPO: none\nLEARNINGS-YETI: below threshold", ctx);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("already past threshold → trigger not fired again", async () => {
    const trigger = vi.fn();
    setConsolidatorTrigger(trigger);
    mockDb.countPendingLearnings.mockReturnValueOnce(6).mockReturnValueOnce(7);
    await enforceLearnings("LEARNINGS-REPO: none\nLEARNINGS-YETI: still above threshold", ctx);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("retry runAI rejection is swallowed — the gate never throws", async () => {
    mockClaude.runAI.mockRejectedValueOnce(new Error("timeout"));
    await expect(enforceLearnings("no declaration", ctx)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});
