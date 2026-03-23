import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockPR } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.yeti",
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
  },
  mockGh: {
    listPRs: vi.fn(),
    createPR: vi.fn(),
    pullUrl: (fullName: string, number: number) => `https://github.com/${fullName}/pull/${number}`,
  },
  mockClaude: {
    createWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    enqueue: vi.fn(),
    enqueueCopilot: vi.fn(),
    runAI: vi.fn(),
    hasNewCommits: vi.fn(),
    hasTreeDiff: vi.fn(),
    pushBranch: vi.fn(),
    generateDocsPRDescription: vi.fn(),
    randomSuffix: vi.fn().mockReturnValue("ab12"),
    datestamp: vi.fn().mockReturnValue("20260322"),
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

import { run } from "./mkdocs-update.js";
import { reportError } from "../error-reporter.js";

describe("mkdocs-update", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.listPRs.mockResolvedValue([]);
    mockGh.createPR.mockResolvedValue(100);
    mockClaude.createWorktree.mockResolvedValue("/tmp/worktree");
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.enqueueCopilot.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.runAI.mockResolvedValue("docs updated");
    mockClaude.hasNewCommits.mockResolvedValue(true);
    mockClaude.hasTreeDiff.mockResolvedValue(true);
    mockClaude.pushBranch.mockResolvedValue(undefined);
    mockClaude.removeWorktree.mockResolvedValue(undefined);
    mockClaude.generateDocsPRDescription.mockResolvedValue("## Summary\nUpdated mkdocs");
    // Default: mkdocs.yml exists
    mockFs.existsSync.mockImplementation((p: string) =>
      String(p).endsWith("mkdocs.yml"),
    );
  });

  it("skips repos without mkdocs.yml or mkdocs.yaml", async () => {
    mockFs.existsSync.mockReturnValue(false);

    await run([repo]);

    expect(mockClaude.runAI).not.toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
    expect(mockClaude.removeWorktree).toHaveBeenCalled();
  });

  it("detects mkdocs.yaml as alternative extension", async () => {
    mockFs.existsSync.mockImplementation((p: string) =>
      String(p).endsWith("mkdocs.yaml"),
    );

    await run([repo]);

    expect(mockClaude.runAI).toHaveBeenCalled();
  });

  it("skips repos with existing open mkdocs-update PR", async () => {
    const pr = mockPR({ headRefName: "yeti/mkdocs-update-20260322-ab12" });
    mockGh.listPRs.mockResolvedValue([pr]);

    await run([repo]);

    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
  });

  it("creates PR when Claude produces commits with tree diff", async () => {
    await run([repo]);

    expect(mockClaude.enqueue).toHaveBeenCalled();
    expect(mockClaude.runAI).toHaveBeenCalledWith(
      expect.stringContaining("source code is the single source of truth"),
      "/tmp/worktree",
      undefined,
    );
    expect(mockClaude.pushBranch).toHaveBeenCalledWith(
      "/tmp/worktree",
      expect.stringContaining("yeti/mkdocs-update-"),
    );
    expect(mockGh.createPR).toHaveBeenCalledWith(
      repo.fullName,
      expect.stringContaining("yeti/mkdocs-update-"),
      expect.stringContaining("docs:"),
      "## Summary\nUpdated mkdocs",
    );
    expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("[mkdocs-update] Created PR #100"));
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
  });

  it("does not create PR when Claude produces no commits", async () => {
    mockClaude.hasNewCommits.mockResolvedValue(false);

    await run([repo]);

    expect(mockClaude.pushBranch).not.toHaveBeenCalled();
    expect(mockGh.createPR).not.toHaveBeenCalled();
  });

  it("does not create PR when commits exist but no tree diff", async () => {
    mockClaude.hasNewCommits.mockResolvedValue(true);
    mockClaude.hasTreeDiff.mockResolvedValue(false);

    await run([repo]);

    expect(mockClaude.pushBranch).not.toHaveBeenCalled();
    expect(mockGh.createPR).not.toHaveBeenCalled();
  });

  it("cleans up worktree on success", async () => {
    await run([repo]);

    expect(mockClaude.removeWorktree).toHaveBeenCalledWith(repo, "/tmp/worktree");
  });

  it("cleans up worktree on error and records task failed", async () => {
    mockClaude.runAI.mockRejectedValue(new Error("claude crashed"));

    await run([repo]);

    expect(mockClaude.removeWorktree).toHaveBeenCalled();
    expect(mockDb.recordTaskFailed).toHaveBeenCalledWith(1, expect.stringContaining("claude crashed"));
  });

  it("reports errors without crashing the loop", async () => {
    const repo2 = mockRepo({ name: "test-repo-2", fullName: "test-org/test-repo-2" });

    mockClaude.runAI
      .mockRejectedValueOnce(new Error("first repo error"))
      .mockResolvedValueOnce("docs updated");

    await run([repo, repo2]);

    expect(reportError).toHaveBeenCalledWith(
      "mkdocs-update:process-repo",
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

  it("records task tracking lifecycle", async () => {
    await run([repo]);

    expect(mockDb.recordTaskStart).toHaveBeenCalledWith("mkdocs-update", repo.fullName, 0, null);
    expect(mockDb.updateTaskWorktree).toHaveBeenCalledWith(1, "/tmp/worktree", expect.stringContaining("yeti/mkdocs-update-"));
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(1);
  });

  it("uses enqueueCopilot when JOB_AI backend is copilot", async () => {
    // Re-mock config with copilot backend
    const configMod = await import("../config.js");
    Object.defineProperty(configMod, "JOB_AI", {
      value: { "mkdocs-update": { backend: "copilot" } },
      writable: true,
    });

    await run([repo]);

    expect(mockClaude.enqueueCopilot).toHaveBeenCalled();

    // Reset
    Object.defineProperty(configMod, "JOB_AI", {
      value: {},
      writable: true,
    });
  });
});
