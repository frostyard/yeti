import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  WORK_DIR: "/tmp/yeti-improve-test",
  JOB_AI: {},
  repoAutonomy: (r: { autonomy?: string }) => r?.autonomy ?? "pr",
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
  },
  mockGh: {
    listOpenIssues: vi.fn(),
    listPRs: vi.fn(),
    searchIssues: vi.fn(),
    searchPRs: vi.fn(),
    createPR: vi.fn(),
    pullUrl: (fullName: string, number: number) => `https://github.com/${fullName}/pull/${number}`,
  },
  mockClaude: {
    createWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    enqueue: vi.fn(),
    runAI: vi.fn(),
    resolveEnqueue: vi.fn(),
    hasNewCommits: vi.fn(),
    hasTreeDiff: vi.fn(),
    pushBranch: vi.fn(),
    randomSuffix: vi.fn().mockReturnValue("ab12"),
  },
  mockDb: {
    recordTaskStart: vi.fn().mockReturnValue(1),
    updateTaskWorktree: vi.fn(),
    recordTaskComplete: vi.fn(),
    recordTaskFailed: vi.fn(),
  },
}));

// The job's own fs usage is fully mocked via mockFs. renderPolicy (imported
// transitively via ../policy.js) also reads through node:fs to load
// src/policies/improvement-identifier*.md from real disk, so
// existsSync/readFileSync delegate to the real fs for any "policies" path —
// only the job's own paths go through the mock.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const isPolicyPath = (p: unknown) => typeof p === "string" && p.includes("policies");
  return {
    default: {
      ...actual,
      existsSync: (p: string) => (isPolicyPath(p) ? actual.existsSync(p) : mockFs.existsSync(p)),
      readFileSync: (p: string, enc?: BufferEncoding) =>
        isPolicyPath(p) ? actual.readFileSync(p, enc) : mockFs.readFileSync(p, enc),
    },
  };
});
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);

import { run, parseImprovements, buildAnalysisPrompt, buildImplementationPrompt } from "./improvement-identifier.js";
import { reportError } from "../error-reporter.js";

const validResponse = JSON.stringify({
  improvements: [
    { title: "Consolidate duplicate validation logic", body: "Files `src/a.ts` and `src/b.ts` both validate..." },
    { title: "Remove unused helper function", body: "`src/utils.ts:42` exports `formatDate` which is never imported..." },
  ],
});

const emptyResponse = JSON.stringify({ improvements: [] });

describe("improvement-identifier", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.existsSync.mockReturnValue(true);
    mockGh.listOpenIssues.mockResolvedValue([]);
    mockGh.listPRs.mockResolvedValue([]);
    mockGh.searchIssues.mockResolvedValue([]);
    mockGh.searchPRs.mockResolvedValue([]);
    mockGh.createPR.mockResolvedValue(42);
    mockClaude.createWorktree.mockResolvedValue("/tmp/worktree");
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.resolveEnqueue.mockReturnValue(mockClaude.enqueue);
    mockClaude.runAI.mockResolvedValue(`\`\`\`json\n${validResponse}\n\`\`\``);
    mockClaude.removeWorktree.mockResolvedValue(undefined);
    mockClaude.hasNewCommits.mockResolvedValue(true);
    mockClaude.hasTreeDiff.mockResolvedValue(true);
    mockClaude.pushBranch.mockResolvedValue(undefined);
  });

  it("processes repo even without local clone", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await run([repo]);

    expect(mockGh.listOpenIssues).toHaveBeenCalled();
    expect(mockClaude.createWorktree).toHaveBeenCalled();
  });

  it("skips repo when open improvement PRs exist", async () => {
    mockGh.listPRs.mockResolvedValue([
      { number: 50, title: "refactor: Consolidate logic", headRefName: "yeti/improve-ab12" },
    ]);

    await run([repo]);

    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
    expect(mockClaude.runAI).not.toHaveBeenCalled();
    expect(mockGh.createPR).not.toHaveBeenCalled();
  });

  it("creates PRs from Claude suggestions", async () => {
    await run([repo]);

    // Analysis worktree + 2 implementation worktrees
    expect(mockClaude.createWorktree).toHaveBeenCalledTimes(3);
    expect(mockGh.createPR).toHaveBeenCalledTimes(2);
    expect(mockGh.createPR).toHaveBeenCalledWith(
      repo.fullName,
      "yeti/improve-ab12",
      "refactor: Consolidate duplicate validation logic",
      expect.stringContaining("Files `src/a.ts` and `src/b.ts`"),
    );
    expect(mockGh.createPR).toHaveBeenCalledWith(
      repo.fullName,
      "yeti/improve-ab12",
      "refactor: Remove unused helper function",
      expect.stringContaining("`src/utils.ts:42`"),
    );
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      jobName: "improvement-identifier",
      message: expect.stringContaining("Created PR #42"),
    }));
  });

  it("no PRs created when Claude finds nothing", async () => {
    mockClaude.runAI.mockResolvedValue(`\`\`\`json\n${emptyResponse}\n\`\`\``);

    await run([repo]);

    expect(mockGh.createPR).not.toHaveBeenCalled();
    // Only the analysis worktree
    expect(mockClaude.createWorktree).toHaveBeenCalledTimes(1);
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
  });

  it("dedup skips improvements with matching open issues", async () => {
    mockGh.searchIssues
      .mockResolvedValueOnce([{ number: 5, title: "Consolidate duplicate validation logic" }])
      .mockResolvedValueOnce([]);

    await run([repo]);

    expect(mockGh.createPR).toHaveBeenCalledTimes(1);
    expect(mockGh.createPR).toHaveBeenCalledWith(
      repo.fullName,
      expect.any(String),
      "refactor: Remove unused helper function",
      expect.any(String),
    );
  });

  it("dedup skips improvements with matching open PRs", async () => {
    mockGh.searchPRs
      .mockResolvedValueOnce([{ number: 10, title: "refactor: Consolidate duplicate validation logic" }])
      .mockResolvedValueOnce([]);

    await run([repo]);

    expect(mockGh.createPR).toHaveBeenCalledTimes(1);
    expect(mockGh.createPR).toHaveBeenCalledWith(
      repo.fullName,
      expect.any(String),
      "refactor: Remove unused helper function",
      expect.any(String),
    );
  });

  it("skips PR creation when no commits produced", async () => {
    mockClaude.hasNewCommits.mockResolvedValue(false);

    await run([repo]);

    expect(mockClaude.pushBranch).not.toHaveBeenCalled();
    expect(mockGh.createPR).not.toHaveBeenCalled();
  });

  it("PR title follows refactor: convention", async () => {
    mockClaude.runAI.mockResolvedValue(
      `\`\`\`json\n${JSON.stringify({ improvements: [{ title: "Test improvement", body: "Test body" }] })}\n\`\`\``,
    );

    await run([repo]);

    expect(mockGh.createPR).toHaveBeenCalledWith(
      repo.fullName,
      expect.any(String),
      "refactor: Test improvement",
      expect.any(String),
    );
  });

  it("PR body includes traceability footer", async () => {
    mockClaude.runAI.mockResolvedValue(
      `\`\`\`json\n${JSON.stringify({ improvements: [{ title: "Test", body: "Test body" }] })}\n\`\`\``,
    );

    await run([repo]);

    expect(mockGh.createPR).toHaveBeenCalledWith(
      repo.fullName,
      expect.any(String),
      expect.any(String),
      "Test body\n\n---\n*Automated improvement by yeti improvement-identifier*",
    );
  });

  it("no labels applied to PRs", async () => {
    await run([repo]);

    // createPR only receives 4 args (repo, head, title, body) — no labels arg
    for (const call of mockGh.createPR.mock.calls) {
      expect(call).toHaveLength(4);
    }
  });

  it("analysis worktree is cleaned up before implementation begins", async () => {
    const worktreeOrder: string[] = [];
    mockClaude.createWorktree.mockImplementation(async () => {
      worktreeOrder.push("create");
      return "/tmp/worktree";
    });
    mockClaude.removeWorktree.mockImplementation(async () => {
      worktreeOrder.push("remove");
    });

    await run([repo]);

    // Analysis worktree is created and removed first, then implementation worktrees run concurrently
    // First two entries must be analysis create+remove; remaining are implementation (2 creates + 2 removes)
    expect(worktreeOrder.slice(0, 2)).toEqual(["create", "remove"]);
    expect(worktreeOrder).toHaveLength(6);
    expect(worktreeOrder.filter((op) => op === "create")).toHaveLength(3);
    expect(worktreeOrder.filter((op) => op === "remove")).toHaveLength(3);
  });

  it("implementation worktree is cleaned up on error", async () => {
    // First runClaude call succeeds (analysis), second fails (implementation)
    mockClaude.runAI
      .mockResolvedValueOnce(`\`\`\`json\n${JSON.stringify({ improvements: [{ title: "Test", body: "Body" }] })}\n\`\`\``)
      .mockRejectedValueOnce(new Error("claude crashed"));

    await run([repo]);

    // Analysis worktree + implementation worktree = 2 removals
    expect(mockClaude.removeWorktree).toHaveBeenCalledTimes(2);
  });

  it("error in one improvement does not block others", async () => {
    // Analysis returns 2 improvements; first implementation fails, second succeeds
    mockClaude.runAI
      .mockResolvedValueOnce(`\`\`\`json\n${validResponse}\n\`\`\``)
      .mockRejectedValueOnce(new Error("first impl failed"))
      .mockResolvedValueOnce("done");

    await run([repo]);

    // First impl fails, second should still create a PR
    expect(mockGh.createPR).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(
      "improvement-identifier:implement",
      expect.stringContaining("Consolidate duplicate validation logic"),
      expect.any(Error),
    );
  });

  it("fetches both issue and PR titles for prompt context", async () => {
    mockGh.listOpenIssues.mockResolvedValue([{ number: 1, title: "Fix bug" }]);
    mockGh.listPRs.mockResolvedValue([{ number: 2, title: "refactor: Improve X", headRefName: "yeti/some-other-branch" }]);

    await run([repo]);

    // The analysis runClaude call should include both issue and PR titles
    const analysisPrompt = mockClaude.runAI.mock.calls[0][0] as string;
    expect(analysisPrompt).toContain("Fix bug");
    expect(analysisPrompt).toContain("refactor: Improve X");
  });

  it("handles Claude output parse failure gracefully", async () => {
    mockClaude.runAI.mockResolvedValue("I couldn't analyze the repo, sorry!");

    await run([repo]);

    expect(mockGh.createPR).not.toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
  });

  it("cleans up analysis worktree on error", async () => {
    mockClaude.runAI.mockRejectedValue(new Error("claude crashed"));

    await run([repo]);

    expect(mockClaude.removeWorktree).toHaveBeenCalled();
    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("claude crashed"));
  });

  it("reports errors without crashing the loop", async () => {
    const repo2 = mockRepo({ name: "test-repo-2", fullName: "test-org/test-repo-2" });

    mockClaude.runAI
      .mockRejectedValueOnce(new Error("first repo error"))
      .mockResolvedValueOnce(`\`\`\`json\n${validResponse}\n\`\`\``);

    await run([repo, repo2]);

    expect(reportError).toHaveBeenCalledWith(
      "improvement-identifier:process-repo",
      repo.fullName,
      expect.any(Error),
    );
    // Second repo should still be processed
    expect(mockGh.createPR).toHaveBeenCalledWith(
      repo2.fullName,
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });

  it("caps improvements at MAX_IMPROVEMENTS_PER_RUN", async () => {
    const manyImprovements = JSON.stringify({
      improvements: [
        { title: "Improvement 1", body: "Body 1" },
        { title: "Improvement 2", body: "Body 2" },
        { title: "Improvement 3", body: "Body 3" },
        { title: "Improvement 4", body: "Body 4" },
        { title: "Improvement 5", body: "Body 5" },
        { title: "Improvement 6", body: "Body 6" },
        { title: "Improvement 7", body: "Body 7" },
        { title: "Improvement 8", body: "Body 8" },
        { title: "Improvement 9", body: "Body 9" },
        { title: "Improvement 10", body: "Body 10" },
        { title: "Improvement 11", body: "Body 11" },
        { title: "Improvement 12", body: "Body 12" },
      ],
    });
    mockClaude.runAI.mockResolvedValue(`\`\`\`json\n${manyImprovements}\n\`\`\``);

    await run([repo]);

    // Max 10 PRs created
    expect(mockGh.createPR).toHaveBeenCalledTimes(10);
  });
});

describe("parseImprovements", () => {
  it("parses JSON from code fence", () => {
    const output = "Some text\n```json\n" + validResponse + "\n```\nMore text";
    const result = parseImprovements(output);
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe("Consolidate duplicate validation logic");
  });

  it("parses raw JSON without code fence", () => {
    const result = parseImprovements(validResponse);
    expect(result).toHaveLength(2);
  });

  it("returns empty array for garbled output", () => {
    const result = parseImprovements("This is not JSON at all");
    expect(result).toEqual([]);
  });

  it("returns empty array for invalid JSON structure", () => {
    const result = parseImprovements('```json\n{"not_improvements": []}\n```');
    expect(result).toEqual([]);
  });

  it("filters out items with missing fields", () => {
    const output = JSON.stringify({
      improvements: [
        { title: "Valid", body: "Valid body" },
        { title: "Missing body" },
        { body: "Missing title" },
      ],
    });
    const result = parseImprovements(`\`\`\`json\n${output}\n\`\`\``);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Valid");
  });
});

describe("buildAnalysisPrompt (policy template)", () => {
  // Reconstructs the pre-migration inline prompt independently, proving the
  // policy-template render is behavior-preserving.
  function expected(fullName: string, openIssueTitles: string[], openPRTitles: string[]): string {
    const issueList =
      openIssueTitles.length > 0
        ? openIssueTitles.map((t) => `  - ${t}`).join("\n")
        : "  (none)";

    const prList =
      openPRTitles.length > 0
        ? openPRTitles.map((t) => `  - ${t}`).join("\n")
        : "  (none)";

    return [
      `You are analyzing the repository ${fullName} for opportunities to improve the codebase.`,
      ``,
      `Read the codebase thoroughly. If \`yeti/OVERVIEW.md\` exists, read it first`,
      `(and any linked documents) for context about the architecture and patterns.`,
      ``,
      `Look for meaningful opportunities such as:`,
      `- Code that could be consolidated (duplicate or near-duplicate logic)`,
      `- Overcomplicated code that could be simplified`,
      `- Dead code or unused exports/dependencies`,
      `- Performance issues or inefficiencies`,
      `- Security concerns`,
      `- Missing error handling at system boundaries`,
      `- Stale TODOs or FIXMEs that should be addressed`,
      ``,
      `Guidelines:`,
      `- Be conservative. Only suggest improvements that provide clear, tangible value.`,
      `- Do NOT suggest stylistic changes, comment additions, or trivial refactors.`,
      `- Do NOT suggest adding type annotations, docstrings, or documentation.`,
      `- "No improvements found" is perfectly acceptable — do not manufacture suggestions.`,
      `- Group related improvements into a single suggestion when they should be addressed together.`,
      `- Each suggestion should be specific and actionable, referencing exact files and line numbers.`,
      ``,
      `The following issues are already open in this repository — do NOT re-suggest these:`,
      issueList,
      ``,
      `The following PRs are already open in this repository — do NOT re-suggest these:`,
      prList,
      ``,
      `Respond with ONLY a JSON block in this exact format, no other text:`,
      ``,
      "```json",
      `{`,
      `  "improvements": [`,
      `    {`,
      `      "title": "Short descriptive title (imperative mood)",`,
      `      "body": "Detailed description with file references, what to change, and why"`,
      `    }`,
      `  ]`,
      `}`,
      "```",
      ``,
      `If no improvements are worth suggesting, respond with:`,
      "```json",
      `{ "improvements": [] }`,
      "```",
    ].join("\n");
  }

  it("matches the pre-migration inline builder with no open issues/PRs", () => {
    const out = buildAnalysisPrompt("pr", "acme/widget", [], []);
    expect(out.trimEnd()).toBe(expected("acme/widget", [], []).trimEnd());
  });

  it("matches the pre-migration inline builder with open issues and PRs", () => {
    const issues = ["Fix bug in parser", "Handle empty input"];
    const prs = ["refactor: Improve X", "feat: Add Y"];
    const out = buildAnalysisPrompt("pr", "acme/widget", issues, prs);
    expect(out.trimEnd()).toBe(expected("acme/widget", issues, prs).trimEnd());
  });
});

describe("buildImplementationPrompt (policy template)", () => {
  // Reconstructs the pre-migration inline prompt independently, proving the
  // policy-template render is behavior-preserving.
  function expected(fullName: string, improvement: { title: string; body: string }): string {
    return [
      `You are implementing a specific improvement in the repository ${fullName}.`,
      ``,
      `**Improvement: ${improvement.title}**`,
      improvement.body,
      ``,
      `If \`yeti/OVERVIEW.md\` exists, read it first (and any linked documents) for context.`,
      ``,
      `Implement this improvement. Make clean, focused commits with clear messages.`,
      `Do not make changes beyond what is described above.`,
    ].join("\n");
  }

  it("matches the pre-migration inline builder", () => {
    const improvement = { title: "Consolidate duplicate validation logic", body: "Files `src/a.ts` and `src/b.ts` both validate..." };
    const out = buildImplementationPrompt("pr", "acme/widget", improvement);
    expect(out.trimEnd()).toBe(expected("acme/widget", improvement).trimEnd());
  });
});
