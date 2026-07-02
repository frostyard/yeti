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

import { parseLearnings, stripLearningsDeclaration } from "./learnings.js";

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
});
