import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.yeti",
  SELF_REPO: "frostyard/yeti",
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

const { mockFs, mockGh, mockClaude, mockDb } = vi.hoisted(() => ({
  mockFs: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  },
  mockGh: {
    listOpenIssues: vi.fn(),
    createIssue: vi.fn(),
    searchIssues: vi.fn(),
    issueUrl: (fullName: string, number: number) => `https://github.com/${fullName}/issues/${number}`,
  },
  mockClaude: {
    createWorktreeFromBranch: vi.fn(),
    removeWorktree: vi.fn(),
    enqueue: vi.fn(),
    runAI: vi.fn(),
    resolveEnqueue: vi.fn(),
  },
  mockDb: {
    recordTaskStart: vi.fn().mockReturnValue(1),
    updateTaskWorktree: vi.fn(),
    recordTaskComplete: vi.fn(),
    recordTaskFailed: vi.fn(),
  },
}));

vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);

import { run, PROMPT_REGISTRY, loadState, saveState, parseJudgment, buildReport } from "./prompt-evaluator.js";
import { reportError } from "../error-reporter.js";

// ── Sample AI outputs ──

const sampleTestInputs = JSON.stringify({
  testCases: [
    { title: "Add webhook support", body: "It would be nice to have webhooks." },
    { title: "Improve logging", body: "We need better logging for debugging production issues." },
    { title: "Vague request", body: "Make it faster." },
    { title: "Complex request", body: "Implement a rate limiter with sliding window that integrates with Redis and supports per-user quotas." },
  ],
});

const sampleVariant = JSON.stringify({
  variant: "You are analyzing a GitHub issue... [improved prompt text]",
  rationale: "Added clarifying-questions section to handle underspecified issues.",
});

const sampleJudgment = JSON.stringify({
  scores: {
    current: { specificity: 3, actionability: 4, scopeAwareness: 3, uncertainty: 2 },
    variant: { specificity: 4, actionability: 4, scopeAwareness: 4, uncertainty: 5 },
  },
  winner: "variant",
  reasoning: "The variant handles ambiguity better by asking clarifying questions.",
});

describe("prompt-evaluator", () => {
  const repo = mockRepo({ fullName: "frostyard/yeti" });

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(false); // no state file yet
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (filePath.includes("issue-refiner.ts")) {
        return 'function buildNewPlanPrompt() { return "prompt text"; }';
      }
      throw new Error(`ENOENT: ${filePath}`);
    });
    mockGh.listOpenIssues.mockResolvedValue([]);
    mockGh.createIssue.mockResolvedValue(99);
    mockGh.searchIssues.mockResolvedValue([]);
    mockClaude.createWorktreeFromBranch.mockResolvedValue("/tmp/worktree");
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.resolveEnqueue.mockReturnValue(mockClaude.enqueue);
    mockClaude.removeWorktree.mockResolvedValue(undefined);

    // Default: variant wins all 4 test cases
    mockClaude.runAI
      .mockResolvedValueOnce(`\`\`\`json\n${sampleTestInputs}\n\`\`\``)   // step 2: test inputs
      .mockResolvedValueOnce(`\`\`\`json\n${sampleVariant}\n\`\`\``)      // step 3: variant
      .mockResolvedValueOnce("Current prompt output 1")                    // step 4: A/B run current #1
      .mockResolvedValueOnce("Variant prompt output 1")                    // step 4: A/B run variant #1
      .mockResolvedValueOnce("Current prompt output 2")                    // step 4: A/B run current #2
      .mockResolvedValueOnce("Variant prompt output 2")                    // step 4: A/B run variant #2
      .mockResolvedValueOnce("Current prompt output 3")                    // step 4: A/B run current #3
      .mockResolvedValueOnce("Variant prompt output 3")                    // step 4: A/B run variant #3
      .mockResolvedValueOnce("Current prompt output 4")                    // step 4: A/B run current #4
      .mockResolvedValueOnce("Variant prompt output 4")                    // step 4: A/B run variant #4
      .mockResolvedValueOnce(`\`\`\`json\n${sampleJudgment}\n\`\`\``)     // step 5: judge #1
      .mockResolvedValueOnce(`\`\`\`json\n${sampleJudgment}\n\`\`\``)     // step 5: judge #2
      .mockResolvedValueOnce(`\`\`\`json\n${sampleJudgment}\n\`\`\``)     // step 5: judge #3
      .mockResolvedValueOnce(`\`\`\`json\n${sampleJudgment}\n\`\`\``);    // step 5: judge #4
  });

  it("runs full pipeline and creates issue when variant wins", async () => {
    await run([repo]);

    // 14 AI calls: 1 test gen + 1 variant + 8 A/B + 4 judge
    expect(mockClaude.runAI).toHaveBeenCalledTimes(14);
    expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    expect(mockGh.createIssue).toHaveBeenCalledWith(
      "frostyard/yeti",
      expect.stringContaining("[prompt-evaluator]"),
      expect.stringContaining("variant"),
      ["prompt-improvement"],
    );
  });

  it("does not create issue when variant loses majority", async () => {
    const losingJudgment = JSON.stringify({
      scores: {
        current: { specificity: 5, actionability: 5, scopeAwareness: 5, uncertainty: 5 },
        variant: { specificity: 2, actionability: 2, scopeAwareness: 2, uncertainty: 2 },
      },
      winner: "current",
      reasoning: "Current prompt is already excellent.",
    });

    // Override judge responses — current wins all 4
    mockClaude.runAI
      .mockReset()
      .mockResolvedValueOnce(`\`\`\`json\n${sampleTestInputs}\n\`\`\``)
      .mockResolvedValueOnce(`\`\`\`json\n${sampleVariant}\n\`\`\``)
      .mockResolvedValueOnce("Current output 1")
      .mockResolvedValueOnce("Variant output 1")
      .mockResolvedValueOnce("Current output 2")
      .mockResolvedValueOnce("Variant output 2")
      .mockResolvedValueOnce("Current output 3")
      .mockResolvedValueOnce("Variant output 3")
      .mockResolvedValueOnce("Current output 4")
      .mockResolvedValueOnce("Variant output 4")
      .mockResolvedValueOnce(`\`\`\`json\n${losingJudgment}\n\`\`\``)
      .mockResolvedValueOnce(`\`\`\`json\n${losingJudgment}\n\`\`\``)
      .mockResolvedValueOnce(`\`\`\`json\n${losingJudgment}\n\`\`\``)
      .mockResolvedValueOnce(`\`\`\`json\n${losingJudgment}\n\`\`\``);

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("advances round-robin state after each run", async () => {
    await run([repo]);

    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("prompt-eval-state.json"),
      expect.stringContaining('"lastIndex": 1'),
    );
  });

  it("resumes from saved state", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (filePath.includes("prompt-eval-state.json")) {
        return JSON.stringify({ lastIndex: 2, lastRunDate: "2026-03-22" });
      }
      // Return prompt source for whichever prompt is at index 2
      return 'function buildFollowUpPrompt() { return "prompt text"; }';
    });

    await run([repo]);

    // Should save state with lastIndex advanced to 3
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("prompt-eval-state.json"),
      expect.stringContaining('"lastIndex": 3'),
    );
  });

  it("wraps around when reaching end of registry", async () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockImplementation((filePath: string) => {
      if (filePath.includes("prompt-eval-state.json")) {
        return JSON.stringify({ lastIndex: PROMPT_REGISTRY.length - 1, lastRunDate: "2026-03-22" });
      }
      return 'function buildPrompt() { return "prompt text"; }';
    });

    await run([repo]);

    // Should wrap to 0 + 1 = 1 (or just 0 if we advance after run)
    const writeCall = mockFs.writeFileSync.mock.calls.find(
      (c: unknown[]) => (c[0] as string).includes("prompt-eval-state.json"),
    );
    expect(writeCall).toBeDefined();
    const saved = JSON.parse(writeCall![1] as string);
    expect(saved.lastIndex).toBe(0);
  });

  it("skips creating issue if similar one already exists", async () => {
    mockGh.searchIssues.mockResolvedValue([
      { number: 50, title: "[prompt-evaluator] Improvement found: buildNewPlanPrompt" },
    ]);

    await run([repo]);

    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });

  it("cleans up worktree on error", async () => {
    mockClaude.runAI.mockReset().mockRejectedValue(new Error("AI crashed"));

    await run([repo]);

    expect(mockClaude.removeWorktree).toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      "prompt-evaluator:evaluate",
      expect.any(String),
      expect.any(Error),
    );
  });

  it("handles missing prompt source file gracefully", async () => {
    mockFs.readFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file");
    });

    await run([repo]);

    expect(reportError).toHaveBeenCalled();
    expect(mockGh.createIssue).not.toHaveBeenCalled();
  });
});

describe("PROMPT_REGISTRY", () => {
  it("contains 5 plan-producing prompts", () => {
    expect(PROMPT_REGISTRY).toHaveLength(5);
  });

  it("each entry has required fields", () => {
    for (const entry of PROMPT_REGISTRY) {
      expect(entry).toHaveProperty("name");
      expect(entry).toHaveProperty("file");
      expect(entry).toHaveProperty("functionName");
      expect(entry).toHaveProperty("purpose");
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.file).toBe("string");
      expect(typeof entry.functionName).toBe("string");
      expect(typeof entry.purpose).toBe("string");
    }
  });

  it("has unique names", () => {
    const names = PROMPT_REGISTRY.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("loadState / saveState", () => {
  it("returns default state when file does not exist", () => {
    mockFs.existsSync.mockReturnValue(false);
    const state = loadState();
    expect(state).toEqual({ lastIndex: 0, lastRunDate: "" });
  });

  it("reads state from file", () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify({ lastIndex: 3, lastRunDate: "2026-03-22" }));
    const state = loadState();
    expect(state.lastIndex).toBe(3);
    expect(state.lastRunDate).toBe("2026-03-22");
  });

  it("saves state to file", () => {
    saveState({ lastIndex: 2, lastRunDate: "2026-03-23" });
    expect(mockFs.mkdirSync).toHaveBeenCalled();
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("prompt-eval-state.json"),
      expect.stringContaining('"lastIndex": 2'),
    );
  });
});

describe("parseJudgment", () => {
  it("parses valid judgment JSON", () => {
    const result = parseJudgment(`\`\`\`json\n${sampleJudgment}\n\`\`\``);
    expect(result).not.toBeNull();
    expect(result!.winner).toBe("variant");
    expect(result!.scores.variant.specificity).toBe(4);
  });

  it("returns null for garbled output", () => {
    expect(parseJudgment("not json")).toBeNull();
  });

  it("returns null for missing winner field", () => {
    const noWinner = JSON.stringify({ scores: {}, reasoning: "test" });
    expect(parseJudgment(noWinner)).toBeNull();
  });

  it("returns null for invalid score values", () => {
    const badScores = JSON.stringify({
      scores: {
        current: { specificity: "high", actionability: 3, scopeAwareness: 3, uncertainty: 3 },
        variant: { specificity: 4, actionability: 4, scopeAwareness: 4, uncertainty: 4 },
      },
      winner: "variant",
      reasoning: "test",
    });
    expect(parseJudgment(badScores)).toBeNull();
  });

  it("returns null for out-of-range scores", () => {
    const outOfRange = JSON.stringify({
      scores: {
        current: { specificity: 0, actionability: 3, scopeAwareness: 3, uncertainty: 3 },
        variant: { specificity: 4, actionability: 4, scopeAwareness: 6, uncertainty: 4 },
      },
      winner: "variant",
      reasoning: "test",
    });
    expect(parseJudgment(outOfRange)).toBeNull();
  });

  it("returns null for missing reasoning", () => {
    const noReasoning = JSON.stringify({
      scores: {
        current: { specificity: 3, actionability: 3, scopeAwareness: 3, uncertainty: 3 },
        variant: { specificity: 4, actionability: 4, scopeAwareness: 4, uncertainty: 4 },
      },
      winner: "variant",
    });
    expect(parseJudgment(noReasoning)).toBeNull();
  });
});

describe("buildReport", () => {
  it("includes prompt name in title", () => {
    const report = buildReport("buildNewPlanPrompt", "the variant prompt text", "rationale text", [
      {
        testCase: { title: "Test", body: "Body" },
        currentOutput: "current output",
        variantOutput: "variant output",
        judgment: { scores: { current: { specificity: 3, actionability: 3, scopeAwareness: 3, uncertainty: 3 }, variant: { specificity: 4, actionability: 4, scopeAwareness: 4, uncertainty: 4 } }, winner: "variant" as const, reasoning: "better" },
      },
    ]);
    expect(report.title).toContain("buildNewPlanPrompt");
    expect(report.title).toContain("[prompt-evaluator]");
  });

  it("includes test case details in body", () => {
    const report = buildReport("buildNewPlanPrompt", "the variant prompt text", "rationale text", [
      {
        testCase: { title: "Test issue", body: "Issue body" },
        currentOutput: "current output",
        variantOutput: "variant output",
        judgment: { scores: { current: { specificity: 3, actionability: 3, scopeAwareness: 3, uncertainty: 3 }, variant: { specificity: 4, actionability: 4, scopeAwareness: 4, uncertainty: 4 } }, winner: "variant" as const, reasoning: "better" },
      },
    ]);
    expect(report.body).toContain("Test issue");
    expect(report.body).toContain("current output");
    expect(report.body).toContain("variant output");
    expect(report.body).toContain("rationale text");
    expect(report.body).toContain("the variant prompt text");
  });
});
