import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./config.js", () => ({
  WORK_DIR: "/tmp/test-yeti",
  MAX_CLAUDE_WORKERS: 2,
  CLAUDE_TIMEOUT_MS: 20 * 60 * 1000,
  MAX_COPILOT_WORKERS: 1,
  COPILOT_TIMEOUT_MS: 20 * 60 * 1000,
  MAX_CODEX_WORKERS: 1,
  CODEX_TIMEOUT_MS: 20 * 60 * 1000,
}));

vi.mock("./log.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

let mockShuttingDown = false;
vi.mock("./shutdown.js", async () => {
  const actual = await vi.importActual<typeof import("./shutdown.js")>("./shutdown.js");
  return {
    ...actual,
    isShuttingDown: () => mockShuttingDown,
    setShuttingDown: vi.fn(),
  };
});

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  },
}));

import { enqueue, queueStatus, randomSuffix, datestamp, hasNewCommits, hasTreeDiff, generatePRDescription, generateDocsPRDescription, regeneratePRDescription, runClaude, cancelCurrentTask, cancelQueuedTasks, createWorktree, createWorktreeFromBranch, pushBranch, ensureClone, ClaudeTimeoutError, runAI, copilotQueueStatus, enqueueCopilot, codexQueueStatus, enqueueCodex, AiTimeoutError } from "./claude.js";
import { ShutdownError } from "./shutdown.js";
import * as shutdown from "./shutdown.js";
import fs from "node:fs";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

const mockExecFile = vi.mocked(execFile);
const mockSpawn = vi.mocked(spawn);

describe("randomSuffix", () => {
  it("returns a 4-character hex string", () => {
    const result = randomSuffix();
    expect(result).toMatch(/^[0-9a-f]{4}$/);
  });

  it("returns different values on each call", () => {
    const results = new Set(Array.from({ length: 10 }, () => randomSuffix()));
    expect(results.size).toBeGreaterThan(1);
  });
});

describe("datestamp", () => {
  it("returns an 8-digit date string", () => {
    const result = datestamp();
    expect(result).toMatch(/^\d{8}$/);
  });

  it("returns today's date", () => {
    const result = datestamp();
    const now = new Date();
    const expected =
      `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
    expect(result).toBe(expected);
  });
});

describe("concurrent queue", () => {
  it("enqueues a single task and resolves with its return value", async () => {
    const result = await enqueue(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("runs tasks concurrently up to MAX_CLAUDE_WORKERS", async () => {
    const order: number[] = [];

    const p1 = enqueue(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 10));
      order.push(2);
      return "first";
    });

    const p2 = enqueue(async () => {
      order.push(3);
      return "second";
    });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("first");
    expect(r2).toBe("second");
    // With MAX_CLAUDE_WORKERS=2, both tasks start immediately:
    // p1 pushes 1, p2 pushes 3 (both start), then p1 finishes and pushes 2
    expect(order).toEqual([1, 3, 2]);
  });

  it("respects MAX_CLAUDE_WORKERS=1 for serial execution", async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).MAX_CLAUDE_WORKERS = 1;
    try {
      const order: number[] = [];

      const p1 = enqueue(async () => {
        order.push(1);
        await new Promise((r) => setTimeout(r, 10));
        order.push(2);
        return "first";
      });

      const p2 = enqueue(async () => {
        order.push(3);
        return "second";
      });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBe("first");
      expect(r2).toBe("second");
      expect(order).toEqual([1, 2, 3]); // p2 starts only after p1 finishes
    } finally {
      (configMod as Record<string, unknown>).MAX_CLAUDE_WORKERS = 2;
    }
  });

  it("a rejected task does not block the queue", async () => {
    const p1 = enqueue(() => Promise.reject(new Error("fail")));
    const p2 = enqueue(() => Promise.resolve("ok"));

    await expect(p1).rejects.toThrow("fail");
    const result = await p2;
    expect(result).toBe("ok");
  });

  it("queueStatus reflects queue state", async () => {
    // When idle
    const status = queueStatus();
    expect(status.pending).toBe(0);
    expect(status.active).toBe(0);
  });

  it("priority tasks run before non-priority tasks", async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).MAX_CLAUDE_WORKERS = 1;
    try {
      const order: string[] = [];
      let resolveBlocker: () => void;
      const blocker = new Promise<void>((r) => { resolveBlocker = r; });

      // Enqueue a blocking task to fill the single worker slot
      const p0 = enqueue(async () => { await blocker; return "blocker"; });

      // Enqueue non-priority then priority — priority should run first when slot opens
      const p1 = enqueue(async () => { order.push("normal"); return "normal"; });
      const p2 = enqueue(async () => { order.push("priority"); return "priority"; }, true);

      // Release the blocker
      resolveBlocker!();
      await p0;
      await Promise.all([p1, p2]);

      expect(order).toEqual(["priority", "normal"]);
    } finally {
      (configMod as Record<string, unknown>).MAX_CLAUDE_WORKERS = 2;
    }
  });
});

describe("hasNewCommits", () => {
  it("returns true when rev-list count > 0", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("rev-list")) {
        cb(null, "3\n", "");
      }
      return undefined as any;
    });

    const result = await hasNewCommits("/tmp/wt", "main");
    expect(result).toBe(true);
  });

  it("returns false when rev-list count is 0", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("rev-list")) {
        cb(null, "0\n", "");
      }
      return undefined as any;
    });

    const result = await hasNewCommits("/tmp/wt", "main");
    expect(result).toBe(false);
  });
});

describe("hasTreeDiff", () => {
  it("returns true when git diff --quiet exits with code 1 (tree differs)", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("diff") && args?.includes("--quiet")) {
        const err = Object.assign(new Error("diff"), { code: 1 });
        cb(err, "", "");
      }
      return undefined as any;
    });

    const result = await hasTreeDiff("/tmp/wt", "main");
    expect(result).toBe(true);
  });

  it("returns false when git diff --quiet exits with code 0 (identical trees)", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("diff") && args?.includes("--quiet")) {
        cb(null, "", "");
      }
      return undefined as any;
    });

    const result = await hasTreeDiff("/tmp/wt", "main");
    expect(result).toBe(false);
  });
});

describe("runClaude", () => {
  afterEach(() => {
    mockShuttingDown = false;
  });

  it("resolves with stdout on success", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test prompt", "/tmp");

    stdoutEmitter.emit("data", Buffer.from("output text"));
    child.emit("close", 0, null);

    const result = await promise;
    expect(result).toBe("output text");
    expect(stdinMock.write).toHaveBeenCalledWith("test prompt");
    expect(stdinMock.end).toHaveBeenCalled();
  });

  it("still resolves stdout on non-zero exit code", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test", "/tmp");
    stdoutEmitter.emit("data", Buffer.from("partial output"));
    stderrEmitter.emit("data", Buffer.from("error msg"));
    child.emit("close", 1, null);

    const result = await promise;
    expect(result).toBe("partial output");
  });

  it("rejects on spawn error", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test", "/tmp");
    child.emit("error", new Error("spawn failed"));

    await expect(promise).rejects.toThrow("Failed to spawn claude");
  });

  it("rejects with cancellation error when cancelCurrentTask is called", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn() };
    const killMock = vi.fn();

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
      kill: killMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test prompt", "/tmp");

    // Cancel while running
    const cancelled = cancelCurrentTask();
    expect(cancelled).toBe(true);
    expect(killMock).toHaveBeenCalledWith("SIGTERM");

    // Simulate process exit after SIGTERM
    child.emit("close", null, "SIGTERM");

    await expect(promise).rejects.toThrow("Task cancelled — shutting down");
    await expect(promise).rejects.toBeInstanceOf(ShutdownError);
  });

  it("rejects with shutdown message when killed by SIGTERM during shutdown", async () => {
    mockShuttingDown = true;
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test", "/tmp");
    child.emit("close", null, "SIGTERM");

    await expect(promise).rejects.toThrow("Task cancelled — shutting down");
    await expect(promise).rejects.toBeInstanceOf(ShutdownError);
  });

  it("rejects with signal error for non-SIGTERM signals during shutdown", async () => {
    mockShuttingDown = true;
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test", "/tmp");
    stderrEmitter.emit("data", Buffer.from("killed"));
    child.emit("close", null, "SIGKILL");

    await expect(promise).rejects.toThrow("claude was killed by signal SIGKILL");
  });

  it("rejects when killed by signal (not via cancelCurrentTask)", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runClaude("test", "/tmp");
    stdoutEmitter.emit("data", Buffer.from("partial"));
    stderrEmitter.emit("data", Buffer.from("some error"));
    child.emit("close", null, "SIGTERM");

    await expect(promise).rejects.toThrow("claude was killed by signal SIGTERM");
  });

  it("cancelCurrentTask returns false when no process is active", () => {
    expect(cancelCurrentTask()).toBe(false);
  });

  it("rejects with ClaudeTimeoutError carrying diagnostics when process times out", async () => {
    vi.useFakeTimers();
    try {
      const child = new EventEmitter() as ChildProcess & EventEmitter;
      const stdoutEmitter = new EventEmitter();
      const stderrEmitter = new EventEmitter();
      const stdinMock = { write: vi.fn(), end: vi.fn() };
      const killMock = vi.fn();

      Object.assign(child, {
        stdout: stdoutEmitter,
        stderr: stderrEmitter,
        stdin: stdinMock,
        kill: killMock,
        pid: 12345,
      });

      mockSpawn.mockReturnValue(child as any);

      const promise = runClaude("test prompt", "/tmp/test-cwd");

      // Emit some output before timeout
      stdoutEmitter.emit("data", Buffer.from("partial work output"));
      stderrEmitter.emit("data", Buffer.from("some stderr"));

      // Advance past the timeout (20 min)
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);

      // Process exits after SIGTERM
      child.emit("close", null, "SIGTERM");

      const err = await promise.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ClaudeTimeoutError);
      const timeoutErr = err as ClaudeTimeoutError;
      expect(timeoutErr.message).toContain("timed out after 1200000ms");
      expect(timeoutErr.outputBytes).toBe("partial work output".length);
      expect(timeoutErr.lastOutput).toBe("partial work output");
      expect(timeoutErr.lastStderr).toBe("some stderr");
      expect(timeoutErr.cwd).toBe("/tmp/test-cwd");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("generatePRDescription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns claude-generated description on success", async () => {
    // Mock git diff
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("diff") && !args?.includes("--stat")) {
        cb(null, "diff output here", "");
      }
      return undefined as any;
    });

    // Mock runClaude (via spawn)
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    const promise = generatePRDescription("/tmp/wt", "main", {
      number: 1,
      title: "Test",
      body: "Fix something",
    });

    // Let the enqueue/runClaude call propagate
    await vi.advanceTimersByTimeAsync(0);

    stdoutEmitter.emit("data", Buffer.from("## Summary\nFixed the thing"));
    child.emit("close", 0, null);

    const result = await promise;
    expect(result).toBe("## Summary\nFixed the thing");
  });

  it("throws when claude fails", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("diff")) {
        cb(null, "diff content", "");
      }
      return undefined as any;
    });

    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    const promise = generatePRDescription("/tmp/wt", "main", {
      number: 1,
      title: "Test",
      body: "body",
    });

    await vi.advanceTimersByTimeAsync(0);
    child.emit("error", new Error("spawn failed"));

    await expect(promise).rejects.toThrow("Failed to spawn claude");
  });

  it("throws when claude returns empty output", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("diff")) {
        cb(null, "diff content", "");
      }
      return undefined as any;
    });

    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    const promise = generatePRDescription("/tmp/wt", "main", {
      number: 1,
      title: "Test",
      body: "body",
    });

    await vi.advanceTimersByTimeAsync(0);
    stdoutEmitter.emit("data", Buffer.from(""));
    child.emit("close", 0, null);

    await expect(promise).rejects.toThrow("empty PR description");
  });
});

describe("generateDocsPRDescription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns claude-generated description for docs", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("diff") && !args?.includes("--stat")) {
        cb(null, "diff --git a/yeti/OVERVIEW.md b/yeti/OVERVIEW.md\n+new docs", "");
      }
      return undefined as any;
    });

    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    const promise = generateDocsPRDescription("/tmp/wt", "main");

    await vi.advanceTimersByTimeAsync(0);

    // Verify prompt mentions documentation
    expect(stdinMock.write).toHaveBeenCalledWith(expect.stringContaining("documentation"));

    stdoutEmitter.emit("data", Buffer.from("## Summary\nUpdated docs for new module"));
    child.emit("close", 0, null);

    const result = await promise;
    expect(result).toBe("## Summary\nUpdated docs for new module");
  });

  it("throws when claude returns empty output", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("diff")) {
        cb(null, "diff content", "");
      }
      return undefined as any;
    });

    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    const promise = generateDocsPRDescription("/tmp/wt", "main");

    await vi.advanceTimersByTimeAsync(0);
    stdoutEmitter.emit("data", Buffer.from(""));
    child.emit("close", 0, null);

    await expect(promise).rejects.toThrow("empty PR description");
  });
});

describe("regeneratePRDescription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns claude-generated description from diff and PR title", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("diff") && !args?.includes("--stat")) {
        cb(null, "diff output here", "");
      }
      return undefined as any;
    });

    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    const promise = regeneratePRDescription("/tmp/wt", "main", {
      number: 5,
      title: "Fix CI",
    });

    await vi.advanceTimersByTimeAsync(0);

    // Verify prompt references the PR title
    expect(stdinMock.write).toHaveBeenCalledWith(expect.stringContaining("Fix CI"));

    stdoutEmitter.emit("data", Buffer.from("## Summary\nFixed CI issues"));
    child.emit("close", 0, null);

    const result = await promise;
    expect(result).toBe("## Summary\nFixed CI issues");
  });

  it("throws when claude returns empty output", async () => {
    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.includes("diff")) {
        cb(null, "diff content", "");
      }
      return undefined as any;
    });

    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn() };
    Object.assign(child, { stdout: stdoutEmitter, stderr: stderrEmitter, stdin: stdinMock });
    mockSpawn.mockReturnValue(child as any);

    const promise = regeneratePRDescription("/tmp/wt", "main", {
      number: 5,
      title: "Fix CI",
    });

    await vi.advanceTimersByTimeAsync(0);
    stdoutEmitter.emit("data", Buffer.from(""));
    child.emit("close", 0, null);

    await expect(promise).rejects.toThrow("empty PR description");
  });
});

describe("ensureClone coalescing", () => {
  const mockFs = vi.mocked(fs);
  const repo = { owner: "test-owner", name: "test-repo", fullName: "test-owner/test-repo", defaultBranch: "main" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("concurrent createWorktree calls for the same repo only fetch once", async () => {
    let fetchCallCount = 0;

    // .git exists (existing clone) — fetch path
    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      // worktree path doesn't exist yet
      return false;
    });
    mockFs.mkdirSync.mockReturnValue(undefined as any);

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.[0] === "fetch") {
        fetchCallCount++;
        // Simulate slow fetch
        setTimeout(() => cb(null, "", ""), 50);
      } else if (args?.[0] === "checkout") {
        cb(null, "", "");
      } else if (args?.[0] === "branch") {
        // git branch -D (cleanup) — pretend branch doesn't exist
        cb(new Error("branch not found"), "", "branch not found");
      } else if (args?.[0] === "worktree") {
        if (args?.[1] === "add") {
          cb(null, "", "");
        } else if (args?.[1] === "remove") {
          cb(null, "", "");
        } else if (args?.[1] === "prune") {
          cb(null, "", "");
        }
      }
      return undefined as any;
    });

    const p1 = createWorktree(repo, "branch-a", "test-job");
    const p2 = createWorktree(repo, "branch-b", "test-job");

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toContain("branch-a");
    expect(r2).toContain("branch-b");
    // The key assertion: fetch was called only once, not twice
    expect(fetchCallCount).toBe(1);
  });

  it("createWorktree passes --no-track to avoid .git/config lock contention", async () => {
    const worktreeAddCalls: string[][] = [];

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });
    mockFs.mkdirSync.mockReturnValue(undefined as any);

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.[0] === "fetch") {
        cb(null, "", "");
      } else if (args?.[0] === "checkout") {
        cb(null, "", "");
      } else if (args?.[0] === "branch") {
        cb(new Error("branch not found"), "", "");
      } else if (args?.[0] === "worktree" && args?.[1] === "add") {
        worktreeAddCalls.push([...args]);
        cb(null, "", "");
      } else if (args?.[0] === "worktree" && args?.[1] === "prune") {
        cb(null, "", "");
      }
      return undefined as any;
    });

    await createWorktree(repo, "branch-test", "test-job");

    expect(worktreeAddCalls).toHaveLength(1);
    expect(worktreeAddCalls[0]).toContain("--no-track");
  });

  it("ensureClone updates working directory with checkout after fetch", async () => {
    const gitCalls: string[][] = [];

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      gitCalls.push([...args]);
      if (args?.[0] === "fetch") {
        cb(null, "", "");
      } else if (args?.[0] === "checkout") {
        cb(null, "", "");
      }
      return undefined as any;
    });

    await ensureClone(repo);

    const fetchCall = gitCalls.find((c) => c[0] === "fetch");
    const checkoutCall = gitCalls.find((c) => c[0] === "checkout");
    expect(fetchCall).toBeDefined();
    expect(checkoutCall).toEqual(["checkout", "origin/main", "--force"]);

    // checkout must come after fetch
    const fetchIdx = gitCalls.indexOf(fetchCall!);
    const checkoutIdx = gitCalls.indexOf(checkoutCall!);
    expect(fetchIdx).toBeLessThan(checkoutIdx);
  });

  it("after coalesced fetch completes, next call triggers a new fetch", async () => {
    let fetchCallCount = 0;

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });
    mockFs.mkdirSync.mockReturnValue(undefined as any);

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.[0] === "fetch") {
        fetchCallCount++;
        setTimeout(() => cb(null, "", ""), 10);
      } else if (args?.[0] === "checkout") {
        cb(null, "", "");
      } else if (args?.[0] === "branch") {
        cb(new Error("branch not found"), "", "");
      } else if (args?.[0] === "worktree") {
        cb(null, "", "");
      }
      return undefined as any;
    });

    // First call
    await createWorktree(repo, "branch-1", "test-job");
    expect(fetchCallCount).toBe(1);

    // Second call after completion — should fetch again
    await createWorktree(repo, "branch-2", "test-job");
    expect(fetchCallCount).toBe(2);
  });

  it("fetch error propagates to all concurrent callers", async () => {
    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      if (args?.[0] === "fetch") {
        setTimeout(() => cb(new Error("ref lock error"), "", "cannot lock ref"), 10);
      }
      return undefined as any;
    });

    const p1 = createWorktree(repo, "branch-x", "test-job");
    const p2 = createWorktree(repo, "branch-y", "test-job");

    await expect(p1).rejects.toThrow("fetch");
    await expect(p2).rejects.toThrow("fetch");
  });
});

describe("createWorktreeFromBranch", () => {
  const mockFs = vi.mocked(fs);
  const repo = { owner: "test-owner", name: "test-repo", fullName: "test-owner/test-repo", defaultBranch: "main" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates worktree in detached HEAD mode", async () => {
    const gitCalls: string[][] = [];

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });
    mockFs.mkdirSync.mockReturnValue(undefined as any);

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      gitCalls.push([...args]);
      cb(null, "", "");
      return undefined as any;
    });

    await createWorktreeFromBranch(repo, "dependabot/npm/eslint-10", "ci-fixer");

    // Verify --detach is used with origin/ prefix
    const worktreeCall = gitCalls.find((c) => c[0] === "worktree" && c[1] === "add");
    expect(worktreeCall).toBeDefined();
    expect(worktreeCall).toContain("--detach");
    expect(worktreeCall).toContain("origin/dependabot/npm/eslint-10");

    // Verify no branch -f call exists (removed)
    const branchCall = gitCalls.find((c) => c[0] === "branch" && c[1] === "-f");
    expect(branchCall).toBeUndefined();
  });

  it("two worktrees can use the same branch with different namespaces", async () => {
    const gitCalls: string[][] = [];

    mockFs.existsSync.mockImplementation((p: any) => {
      const s = String(p);
      if (s.endsWith(".git")) return true;
      return false;
    });
    mockFs.mkdirSync.mockReturnValue(undefined as any);

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      gitCalls.push([...args]);
      cb(null, "", "");
      return undefined as any;
    });

    const wt1 = await createWorktreeFromBranch(repo, "yeti/improve-82cd", "ci-fixer");
    const wt2 = await createWorktreeFromBranch(repo, "yeti/improve-82cd", "review-addresser");

    // Both worktrees should have different paths
    expect(wt1).toContain("ci-fixer");
    expect(wt2).toContain("review-addresser");
    expect(wt1).not.toEqual(wt2);

    // Both should use --detach with origin/ prefix
    const worktreeCalls = gitCalls.filter((c) => c[0] === "worktree" && c[1] === "add");
    expect(worktreeCalls).toHaveLength(2);
    for (const call of worktreeCalls) {
      expect(call).toContain("--detach");
      expect(call).toContain("origin/yeti/improve-82cd");
    }
  });
});

describe("pushBranch", () => {
  it("pushes HEAD to the named remote branch using refspec", async () => {
    const gitCalls: string[][] = [];

    mockExecFile.mockImplementation((_cmd, args: any, _opts: any, cb: any) => {
      gitCalls.push([...args]);
      cb(null, "", "");
      return undefined as any;
    });

    await pushBranch("/some/worktree", "yeti/improve-82cd");

    expect(gitCalls).toEqual([["push", "origin", "HEAD:refs/heads/yeti/improve-82cd"]]);
  });
});

describe("cancelQueuedTasks", () => {
  it("rejects all pending items in the queue", async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).MAX_CLAUDE_WORKERS = 0;
    try {
      // With MAX_CLAUDE_WORKERS=0, tasks stay queued (never start)
      const p1 = enqueue(() => Promise.resolve("a"));
      const p2 = enqueue(() => Promise.resolve("b"));

      cancelQueuedTasks();

      await expect(p1).rejects.toThrow("Shutting down — task cancelled");
      await expect(p1).rejects.toBeInstanceOf(ShutdownError);
      await expect(p2).rejects.toThrow("Shutting down — task cancelled");
      await expect(p2).rejects.toBeInstanceOf(ShutdownError);
    } finally {
      (configMod as Record<string, unknown>).MAX_CLAUDE_WORKERS = 2;
    }
  });
});

describe("enqueue shutdown guard", () => {
  afterEach(() => {
    mockShuttingDown = false;
  });

  it("rejects immediately when shutting down", async () => {
    mockShuttingDown = true;
    const promise = enqueue(() => Promise.resolve("x"));
    await expect(promise).rejects.toThrow("Shutting down — task not started");
    await expect(promise).rejects.toBeInstanceOf(ShutdownError);
  });
});

function createMockChild() {
  const child = new EventEmitter() as ChildProcess & EventEmitter;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const stdinMock = { write: vi.fn(), end: vi.fn() };
  Object.assign(child, {
    stdout: stdoutEmitter,
    stderr: stderrEmitter,
    stdin: stdinMock,
  });
  return child;
}

describe("runAI", () => {
  it("defaults to claude backend when no options provided", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ChildProcess);

    const promise = runAI("test prompt", "/tmp/test");
    child.stdout!.emit("data", Buffer.from("claude output"));
    child.emit("close", 0, null);

    const result = await promise;
    expect(result).toBe("claude output");
    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      ["-p", "--dangerously-skip-permissions"],
      expect.objectContaining({ cwd: "/tmp/test" }),
    );
  });

  it("uses copilot backend when specified", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ChildProcess);

    const promise = runAI("test prompt", "/tmp/test", { backend: "copilot" });
    child.stdout!.emit("data", Buffer.from("copilot output"));
    child.emit("close", 0, null);

    const result = await promise;
    expect(result).toBe("copilot output");
    expect(mockSpawn).toHaveBeenCalledWith(
      "copilot",
      ["-p", "test prompt", "--allow-all-tools", "-s", "--no-ask-user"],
      expect.objectContaining({ cwd: "/tmp/test" }),
    );
  });

  it("appends --model flag when model option is provided", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ChildProcess);

    const promise = runAI("test prompt", "/tmp/test", { backend: "copilot", model: "gemini-3-pro" });
    child.stdout!.emit("data", Buffer.from("output"));
    child.emit("close", 0, null);

    await promise;
    expect(mockSpawn).toHaveBeenCalledWith(
      "copilot",
      ["-p", "test prompt", "--allow-all-tools", "-s", "--no-ask-user", "--model", "gemini-3-pro"],
      expect.objectContaining({ cwd: "/tmp/test" }),
    );
  });

  it("appends --model flag for claude backend", async () => {
    const child = createMockChild();
    mockSpawn.mockReturnValueOnce(child as unknown as ChildProcess);

    const promise = runAI("test prompt", "/tmp/test", { model: "claude-sonnet-4-6" });
    child.stdout!.emit("data", Buffer.from("output"));
    child.emit("close", 0, null);

    await promise;
    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      ["-p", "--dangerously-skip-permissions", "--model", "claude-sonnet-4-6"],
      expect.objectContaining({ cwd: "/tmp/test" }),
    );
  });
});

describe("AiTimeoutError alias", () => {
  it("ClaudeTimeoutError is the same as AiTimeoutError", () => {
    expect(ClaudeTimeoutError).toBe(AiTimeoutError);
  });
});

describe("copilot queue", () => {
  it("reports copilot queue status independently", () => {
    const status = copilotQueueStatus();
    expect(status).toEqual({ pending: 0, active: 0 });
  });

  it("enqueues and resolves copilot tasks", async () => {
    const result = await enqueueCopilot(() => Promise.resolve("copilot-result"));
    expect(result).toBe("copilot-result");
  });
});

describe("codex queue", () => {
  it("reports codex queue status independently", () => {
    const status = codexQueueStatus();
    expect(status).toEqual({ pending: 0, active: 0 });
  });

  it("enqueues and resolves codex tasks", async () => {
    const result = await enqueueCodex(() => Promise.resolve("codex-result"));
    expect(result).toBe("codex-result");
  });

  it("rejects immediately when maxCodexWorkers is 0", async () => {
    const configMock = await import("./config.js") as Record<string, unknown>;
    const original = configMock["MAX_CODEX_WORKERS"];
    configMock["MAX_CODEX_WORKERS"] = 0;
    try {
      await expect(enqueueCodex(() => Promise.resolve("nope"))).rejects.toThrow(
        "Codex backend is disabled",
      );
    } finally {
      configMock["MAX_CODEX_WORKERS"] = original;
    }
  });
});

describe("runAI with codex backend", () => {
  it("uses codex binary with positional prompt and correct args", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runAI("do the thing", "/tmp/codex-test", { backend: "codex" });

    // Verify spawn was called with codex binary and correct args
    expect(mockSpawn).toHaveBeenCalledWith(
      "codex",
      ["exec", "--full-auto", "do the thing"],
      expect.objectContaining({ cwd: "/tmp/codex-test" }),
    );

    // Prompt should NOT be written to stdin for positional mode
    expect(stdinMock.write).not.toHaveBeenCalled();
    expect(stdinMock.end).toHaveBeenCalled();

    stdoutEmitter.emit("data", Buffer.from("codex output"));
    child.emit("close", 0, null);

    const result = await promise;
    expect(result).toBe("codex output");
  });

  it("places model flag before positional prompt", async () => {
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const stdoutEmitter = new EventEmitter();
    const stderrEmitter = new EventEmitter();
    const stdinMock = { write: vi.fn(), end: vi.fn() };

    Object.assign(child, {
      stdout: stdoutEmitter,
      stderr: stderrEmitter,
      stdin: stdinMock,
    });

    mockSpawn.mockReturnValue(child as any);

    const promise = runAI("do the thing", "/tmp/codex-test", { backend: "codex", model: "o3" });

    // Model flag should come before the positional prompt
    expect(mockSpawn).toHaveBeenCalledWith(
      "codex",
      ["exec", "--full-auto", "--model", "o3", "do the thing"],
      expect.objectContaining({ cwd: "/tmp/codex-test" }),
    );

    stdoutEmitter.emit("data", Buffer.from("ok"));
    child.emit("close", 0, null);
    await promise;
  });
});
