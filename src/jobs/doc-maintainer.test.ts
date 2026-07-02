import { stripPreamble } from "../test-preamble.js";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockPR } from "../test-helpers.js";

const { __tier } = vi.hoisted(() => ({ __tier: {} as Record<string, string> }));
vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.yeti",
  JOB_AI: {},
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

const { mockFs, mockGh, mockClaude, mockDb, mockPlanParser } = vi.hoisted(() => ({
  mockFs: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    rmSync: vi.fn(),
  },
  mockGh: {
    listPRs: vi.fn(),
    createPR: vi.fn(),
    listRecentlyClosedIssues: vi.fn(),
    getIssueComments: vi.fn(),
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
    getHeadSha: vi.fn(),
    getLastDocMaintainerSha: vi.fn(),
    getCommitDate: vi.fn(),
    generateDocsPRDescription: vi.fn(),
    randomSuffix: vi.fn().mockReturnValue("ab12"),
    datestamp: vi.fn().mockReturnValue("20260318"),
    git: vi.fn(),
  },
  mockDb: {
    recordTaskStart: vi.fn().mockReturnValue(1),
    updateTaskWorktree: vi.fn(),
    recordTaskComplete: vi.fn(),
    recordTaskFailed: vi.fn(),
  },
  mockPlanParser: {
    findPlanComment: vi.fn(),
  },
}));

// The job's own fs usage (CLAUDE.md, .plans/) is fully mocked via mockFs.
// renderPolicy (imported transitively via ../policy.js) also reads through
// node:fs to load src/policies/doc-maintainer*.md from real disk, so
// existsSync/readFileSync delegate to the real fs for any "policies" path —
// only the job's own paths (CLAUDE.md, .plans/) go through the mock.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const isPolicyPath = (p: unknown) => typeof p === "string" && p.includes("policies");
  return {
    default: {
      ...actual,
      existsSync: (p: string) => (isPolicyPath(p) ? actual.existsSync(p) : mockFs.existsSync(p)),
      readFileSync: (p: string, enc?: BufferEncoding) =>
        isPolicyPath(p) ? actual.readFileSync(p, enc) : mockFs.readFileSync(p, enc),
      mkdirSync: mockFs.mkdirSync,
      writeFileSync: mockFs.writeFileSync,
      rmSync: mockFs.rmSync,
    },
  };
});
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);
vi.mock("../plan-parser.js", () => mockPlanParser);

import { run, ensureClaudeMdDocBlock, buildDocPrompt } from "./doc-maintainer.js";
import { reportError } from "../error-reporter.js";

describe("doc-maintainer", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    for (const k in __tier) delete __tier[k];
    mockFs.existsSync.mockReturnValue(true);
    // Default: CLAUDE.md already has both directives so ensureClaudeMdDocBlock is a no-op
    mockFs.readFileSync.mockReturnValue(
      "# CLAUDE.md\n\n## Documentation\n\n**update documentation** text\n\n**yeti/ directory** text\n",
    );
    mockGh.listPRs.mockResolvedValue([]);
    mockGh.createPR.mockResolvedValue(100);
    mockGh.listRecentlyClosedIssues.mockResolvedValue([]);
    mockGh.getIssueComments.mockResolvedValue([]);
    mockClaude.createWorktree.mockResolvedValue("/tmp/worktree");
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.resolveEnqueue.mockReturnValue(mockClaude.enqueue);
    mockClaude.runAI.mockResolvedValue("docs generated");
    mockClaude.hasNewCommits.mockResolvedValue(true);
    mockClaude.hasTreeDiff.mockResolvedValue(true);
    mockClaude.pushBranch.mockResolvedValue(undefined);
    mockClaude.removeWorktree.mockResolvedValue(undefined);
    mockClaude.getHeadSha.mockResolvedValue("abc123");
    mockClaude.getLastDocMaintainerSha.mockResolvedValue(null);
    mockClaude.getCommitDate.mockResolvedValue(new Date("2025-01-01"));
    mockClaude.generateDocsPRDescription.mockResolvedValue("## Summary\nUpdated docs");
    mockClaude.git.mockResolvedValue("");
    mockPlanParser.findPlanComment.mockReturnValue(null);
  });

  it("processes repo even without local clone", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await run([repo]);

    expect(mockGh.listPRs).toHaveBeenCalledWith(repo.fullName);
    expect(mockClaude.createWorktree).toHaveBeenCalled();
  });

  it("skips repo when open docs PR already exists", async () => {
    const pr = mockPR({ headRefName: "yeti/docs-ab12" });
    mockGh.listPRs.mockResolvedValue([pr]);

    await run([repo]);

    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
  });

  it("skips repo when HEAD matches last doc-maintainer commit", async () => {
    mockClaude.getHeadSha.mockResolvedValue("abc123");
    mockClaude.getLastDocMaintainerSha.mockResolvedValue("abc123");

    await run([repo]);

    expect(mockClaude.runAI).not.toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
  });

  it("creates docs PR when no previous doc-maintainer commit exists", async () => {
    mockClaude.getLastDocMaintainerSha.mockResolvedValue(null);

    await run([repo]);

    expect(mockClaude.runAI).toHaveBeenCalledWith(
      expect.stringContaining("maintaining documentation"),
      "/tmp/worktree",
      undefined,
    );
    expect(mockClaude.generateDocsPRDescription).toHaveBeenCalledWith(
      "/tmp/worktree",
      repo.defaultBranch,
      undefined,
    );
    expect(mockGh.createPR).toHaveBeenCalledWith(
      repo.fullName,
      expect.stringContaining("yeti/docs-"),
      expect.stringContaining("update documentation"),
      "## Summary\nUpdated docs",
    );
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({
      jobName: "doc-maintainer",
      message: expect.stringContaining("Created PR #100"),
    }));
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
  });

  it("creates docs PR when HEAD differs from last doc-maintainer commit", async () => {
    mockClaude.getHeadSha.mockResolvedValue("newsha");
    mockClaude.getLastDocMaintainerSha.mockResolvedValue("oldsha");

    await run([repo]);

    expect(mockClaude.runAI).toHaveBeenCalled();
    expect(mockClaude.pushBranch).toHaveBeenCalled();
    expect(mockGh.createPR).toHaveBeenCalled();
  });

  it("does not create PR when Claude produces no commits", async () => {
    mockClaude.hasNewCommits.mockResolvedValue(false);

    await run([repo]);

    expect(mockClaude.pushBranch).not.toHaveBeenCalled();
    expect(mockGh.createPR).not.toHaveBeenCalled();
  });

  it("cleans up worktree on error", async () => {
    mockClaude.runAI.mockRejectedValue(new Error("claude crashed"));

    await run([repo]);

    expect(mockClaude.removeWorktree).toHaveBeenCalled();
    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("claude crashed"));
  });

  it("reports errors without crashing the loop", async () => {
    const repo2 = mockRepo({ name: "test-repo-2", fullName: "test-org/test-repo-2" });

    mockClaude.runAI
      .mockRejectedValueOnce(new Error("first repo error"))
      .mockResolvedValueOnce("docs generated");

    await run([repo, repo2]);

    expect(reportError).toHaveBeenCalledWith(
      "doc-maintainer:process-repo",
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

  describe("autonomy pre-flight gate", () => {
    it("skips before worktree/AI when repo tier is below 'createPR' (advisory)", async () => {
      const advisoryRepo = mockRepo();
      __tier[advisoryRepo.fullName] = "advisory";

      await run([advisoryRepo]);

      expect(mockClaude.createWorktree).not.toHaveBeenCalled();
      expect(mockClaude.runAI).not.toHaveBeenCalled();
    });
  });

  describe("plan harvesting", () => {
    it("fetches plans from recently-closed issues and writes .plans/ directory", async () => {
      mockGh.listRecentlyClosedIssues.mockResolvedValue([
        { number: 42, title: "Add auth", body: "body", closedAt: "2025-01-15T00:00:00Z" },
      ]);
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: "## Implementation Plan\nDo the thing", login: "bot" },
      ]);
      mockPlanParser.findPlanComment.mockReturnValue("## Implementation Plan\nDo the thing");

      await run([repo]);

      expect(mockFs.mkdirSync).toHaveBeenCalledWith("/tmp/worktree/.plans", { recursive: true });
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        "/tmp/worktree/.plans/42.md",
        expect.stringContaining("# Issue #42: Add auth"),
      );
      // Prompt should include plan instructions
      expect(mockClaude.runAI).toHaveBeenCalledWith(
        expect.stringContaining(".plans/"),
        "/tmp/worktree",
        undefined,
      );
    });

    it("uses last doc-maintainer commit date as since cutoff", async () => {
      const commitDate = new Date("2025-01-10T00:00:00Z");
      mockClaude.getLastDocMaintainerSha.mockResolvedValue("oldsha");
      mockClaude.getHeadSha.mockResolvedValue("newsha");
      mockClaude.getCommitDate.mockResolvedValue(commitDate);

      await run([repo]);

      expect(mockClaude.getCommitDate).toHaveBeenCalledWith("/tmp/worktree", "oldsha");
      expect(mockGh.listRecentlyClosedIssues).toHaveBeenCalledWith(repo.fullName, commitDate);
    });

    it("falls back to 7-day window when no previous doc-maintainer commit", async () => {
      mockClaude.getLastDocMaintainerSha.mockResolvedValue(null);

      await run([repo]);

      const [, sinceDate] = mockGh.listRecentlyClosedIssues.mock.calls[0];
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      // Should be within a few seconds of 7 days ago
      expect(Math.abs(sinceDate.getTime() - sevenDaysAgo)).toBeLessThan(5000);
    });

    it("skips issues without plan comments", async () => {
      mockGh.listRecentlyClosedIssues.mockResolvedValue([
        { number: 10, title: "No plan", body: "body", closedAt: "2025-01-15T00:00:00Z" },
      ]);
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: "just a comment", login: "user" },
      ]);
      mockPlanParser.findPlanComment.mockReturnValue(null);

      await run([repo]);

      expect(mockFs.mkdirSync).not.toHaveBeenCalledWith(
        expect.stringContaining(".plans"),
        expect.anything(),
      );
      // Prompt should NOT include plan instructions
      expect(mockClaude.runAI).toHaveBeenCalledWith(
        expect.not.stringContaining(".plans/"),
        "/tmp/worktree",
        undefined,
      );
    });

    it("cleans up .plans/ directory after Claude runs", async () => {
      mockGh.listRecentlyClosedIssues.mockResolvedValue([
        { number: 42, title: "Add auth", body: "body", closedAt: "2025-01-15T00:00:00Z" },
      ]);
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: "## Implementation Plan\nDo the thing", login: "bot" },
      ]);
      mockPlanParser.findPlanComment.mockReturnValue("## Implementation Plan\nDo the thing");

      await run([repo]);

      expect(mockFs.rmSync).toHaveBeenCalledWith("/tmp/worktree/.plans", { recursive: true });
    });

    it("caps plans at 10 and truncates long plans", async () => {
      // Create 12 closed issues to test the cap
      const issues = Array.from({ length: 12 }, (_, i) => ({
        number: i + 1,
        title: `Issue ${i + 1}`,
        body: "body",
        closedAt: "2025-01-15T00:00:00Z",
      }));
      mockGh.listRecentlyClosedIssues.mockResolvedValue(issues);
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: "## Implementation Plan\nPlan", login: "bot" },
      ]);
      mockPlanParser.findPlanComment.mockReturnValue("## Implementation Plan\nPlan");

      await run([repo]);

      // Should write exactly 10 plan files (the cap)
      expect(mockFs.writeFileSync).toHaveBeenCalledTimes(10);
    });
  });

  describe("CLAUDE.md documentation block", () => {
    it("creates CLAUDE.md with documentation block when file doesn't exist", async () => {
      mockFs.existsSync.mockReturnValue(false);

      await ensureClaudeMdDocBlock("/tmp/worktree");

      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        "/tmp/worktree/CLAUDE.md",
        expect.stringContaining("**update documentation**"),
      );
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        "/tmp/worktree/CLAUDE.md",
        expect.stringContaining("**yeti/ directory**"),
      );
      expect(mockClaude.git).toHaveBeenCalledWith(["add", "CLAUDE.md"], "/tmp/worktree");
      expect(mockClaude.git).toHaveBeenCalledWith(
        ["-c", "user.email=yeti@users.noreply.github.com", "-c", "user.name=Yeti", "commit", "-m", "docs: ensure CLAUDE.md documentation block"],
        "/tmp/worktree",
      );
    });

    it("appends full documentation section when CLAUDE.md exists without ## Documentation", async () => {
      const existing = "# CLAUDE.md\n\n## Build\nnpm run build\n";
      mockFs.readFileSync.mockReturnValue(existing);

      const result = await ensureClaudeMdDocBlock("/tmp/worktree");

      expect(result).toBe(true);
      const written = mockFs.writeFileSync.mock.calls[0][1] as string;
      expect(written).toContain("## Documentation");
      expect(written).toContain("**update documentation**");
      expect(written).toContain("**yeti/ directory**");
      // Original content preserved
      expect(written).toContain("## Build");
    });

    it("appends missing directive to existing ## Documentation section", async () => {
      const existing = [
        "# CLAUDE.md",
        "",
        "## Documentation",
        "",
        "**update documentation** After any change to source code, update relevant documentation in CLAUDE.md, README.md and the yeti/ folder. A task is not complete without reviewing and updating relevant documentation.",
        "",
        "## Build",
        "npm run build",
      ].join("\n");
      mockFs.readFileSync.mockReturnValue(existing);

      const result = await ensureClaudeMdDocBlock("/tmp/worktree");

      expect(result).toBe(true);
      const written = mockFs.writeFileSync.mock.calls[0][1] as string;
      expect(written).toContain("**yeti/ directory**");
      // Should not duplicate existing directive
      expect(written.match(/\*\*update documentation\*\*/g)?.length).toBe(1);
      // Build section should still exist
      expect(written).toContain("## Build");
    });

    it("inserts missing directive at end of file when ## Documentation is the last section", async () => {
      const existing = [
        "# CLAUDE.md",
        "",
        "## Documentation",
        "",
        "**update documentation** After any change to source code, update relevant documentation.",
      ].join("\n");
      mockFs.readFileSync.mockReturnValue(existing);

      const result = await ensureClaudeMdDocBlock("/tmp/worktree");

      expect(result).toBe(true);
      const written = mockFs.writeFileSync.mock.calls[0][1] as string;
      expect(written).toContain("**yeti/ directory**");
    });

    it("skips modification when both directives present in ## Documentation section", async () => {
      const existing = [
        "# CLAUDE.md",
        "",
        "## Documentation",
        "",
        "**update documentation** After any change to source code, update relevant documentation in CLAUDE.md, README.md and the yeti/ folder. A task is not complete without reviewing and updating relevant documentation.",
        "",
        "**yeti/ directory** The `yeti/` directory contains documentation written for AI consumption.",
        "",
      ].join("\n");
      mockFs.readFileSync.mockReturnValue(existing);

      const result = await ensureClaudeMdDocBlock("/tmp/worktree");

      expect(result).toBe(false);
      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
      expect(mockClaude.git).not.toHaveBeenCalled();
    });

    it("does not treat directives outside ## Documentation as compliant", async () => {
      const existing = [
        "# CLAUDE.md",
        "",
        "## Notes",
        "",
        "**update documentation** some text here.",
        "",
        "**yeti/ directory** some text here.",
        "",
      ].join("\n");
      mockFs.readFileSync.mockReturnValue(existing);

      const result = await ensureClaudeMdDocBlock("/tmp/worktree");

      expect(result).toBe(true);
      const written = mockFs.writeFileSync.mock.calls[0][1] as string;
      expect(written).toContain("## Documentation");
    });

    it("commit message does not contain [doc-maintainer]", async () => {
      mockFs.existsSync.mockReturnValue(false);

      await ensureClaudeMdDocBlock("/tmp/worktree");

      const commitCall = mockClaude.git.mock.calls.find(
        (call: string[][]) => call[0].includes("commit"),
      );
      expect(commitCall).toBeDefined();
      const args = commitCall![0];
      const msgIndex = args.indexOf("-m") + 1;
      expect(args[msgIndex]).not.toContain("[doc-maintainer]");
    });

    it("git commit includes user identity via -c flags when creating CLAUDE.md", async () => {
      mockFs.existsSync.mockReturnValue(false);
      await ensureClaudeMdDocBlock("/tmp/worktree");
      const commitCall = mockClaude.git.mock.calls.find(
        (call: string[][]) => call[0].includes("commit"),
      );
      expect(commitCall![0]).toEqual(
        ["-c", "user.email=yeti@users.noreply.github.com", "-c", "user.name=Yeti", "commit", "-m", "docs: ensure CLAUDE.md documentation block"],
      );
    });

    it("git commit includes user identity via -c flags when appending full section", async () => {
      mockFs.readFileSync.mockReturnValue("# CLAUDE.md\n\n## Build\nnpm run build\n");
      await ensureClaudeMdDocBlock("/tmp/worktree");
      const commitCall = mockClaude.git.mock.calls.find(
        (call: string[][]) => call[0].includes("commit"),
      );
      expect(commitCall![0]).toEqual(
        ["-c", "user.email=yeti@users.noreply.github.com", "-c", "user.name=Yeti", "commit", "-m", "docs: ensure CLAUDE.md documentation block"],
      );
    });

    it("git commit includes user identity via -c flags when appending missing directive", async () => {
      const existing = [
        "# CLAUDE.md",
        "",
        "## Documentation",
        "",
        "**update documentation** After any change to source code, update relevant documentation in CLAUDE.md, README.md and the yeti/ folder. A task is not complete without reviewing and updating relevant documentation.",
        "",
      ].join("\n");
      mockFs.readFileSync.mockReturnValue(existing);
      await ensureClaudeMdDocBlock("/tmp/worktree");
      const commitCall = mockClaude.git.mock.calls.find(
        (call: string[][]) => call[0].includes("commit"),
      );
      expect(commitCall![0]).toEqual(
        ["-c", "user.email=yeti@users.noreply.github.com", "-c", "user.name=Yeti", "commit", "-m", "docs: ensure CLAUDE.md documentation block"],
      );
    });

    it("CLAUDE.md change causes job to continue past SHA skip", async () => {
      // CLAUDE.md doesn't exist initially (triggers creation), but .plans
      // and other paths use default behavior
      let claudeMdCreated = false;
      mockFs.existsSync.mockImplementation((p: string) => {
        if (String(p).endsWith("CLAUDE.md")) {
          if (!claudeMdCreated) {
            claudeMdCreated = true;
            return false;
          }
          return true;
        }
        // .plans dir doesn't exist (no plans written in this test)
        if (String(p).includes(".plans")) return false;
        return true;
      });

      // After ensureClaudeMdDocBlock commits, HEAD is now different
      mockClaude.getHeadSha.mockResolvedValue("newsha-after-claudemd");
      mockClaude.getLastDocMaintainerSha.mockResolvedValue("abc123");

      await run([repo]);

      // Should continue to AI run since HEAD differs from last doc SHA
      expect(mockClaude.runAI).toHaveBeenCalled();
    });
  });
});

describe("buildDocPrompt (policy template)", () => {
  // Reconstructs the pre-migration inline prompt independently, proving the
  // policy-template render is behavior-preserving.
  function expected(fullName: string, planCount = 0): string {
    const lines = [
      `You are maintaining documentation for the repository ${fullName}.`,
      ``,
      `Your goal is to create or update documentation under \`yeti/\` that is`,
      `optimized for providing context when planning and implementing new features`,
      `and bug fixes.`,
      ``,
      `Steps:`,
      `1. Run \`mkdir -p yeti\` to ensure the directory exists.`,
      `2. Read the codebase to understand its current structure, purpose, and key`,
      `   patterns.`,
      `3. If \`yeti/OVERVIEW.md\` exists, read it and all docs it links to, then`,
      `   update them to reflect the current state of the code. Preserve accurate`,
      `   content and update anything outdated. If it doesn't exist, create it`,
      `   from scratch.`,
      `4. \`yeti/OVERVIEW.md\` is the main entry point and should include:`,
      `   - **Purpose**: What this repo does and its role (2-3 sentences)`,
      `   - **Architecture**: Key directories, modules, and how they fit together`,
      `   - **Key Patterns**: Important conventions, data flow, and design decisions`,
      `   - **Configuration**: Key config values and environment variables`,
      `5. For complex subsystems that need detailed coverage, create dedicated`,
      `   documents (e.g., \`yeti/database-schema.md\`, \`yeti/api-design.md\`) and`,
      `   link to them from OVERVIEW.md. Keep each focused on one subject.`,
      `6. Keep OVERVIEW.md concise (200-500 lines). Dedicated docs can be longer`,
      `   as needed for thorough coverage.`,
      `7. Commit with message: "docs: update documentation [doc-maintainer]"`,
      ``,
      `Do NOT make any code changes. Only update documentation.`,
    ];

    if (planCount > 0) {
      lines.push(
        ``,
        `A \`.plans/\` directory has been created in the repo root containing implementation`,
        `plans from ${planCount} recently-closed issues. Each file is named by issue number`,
        `(e.g., \`.plans/42.md\`).`,
        ``,
        `Read these plans and extract any valuable architectural context, design decisions,`,
        `conventions, or patterns into the existing documentation. Only add information that`,
        `is actually reflected in the current codebase. If a plan contains nothing new for`,
        `the docs, skip it. Do NOT commit the \`.plans/\` directory — it is temporary.`,
      );
    }

    return lines.join("\n");
  }

  it("matches the pre-migration inline builder with no plans (planCount = 0)", () => {
    const out = buildDocPrompt("pr", "acme/widget", 0);
    expect(stripPreamble(out).trimEnd()).toBe(expected("acme/widget", 0).trimEnd());
  });

  it("matches the pre-migration inline builder with plans (planCount > 0)", () => {
    const out = buildDocPrompt("pr", "acme/widget", 3);
    expect(stripPreamble(out).trimEnd()).toBe(expected("acme/widget", 3).trimEnd());
  });

  it("defaults planCount to 0 when omitted", () => {
    const out = buildDocPrompt("pr", "acme/widget");
    expect(stripPreamble(out).trimEnd()).toBe(expected("acme/widget", 0).trimEnd());
  });
});
