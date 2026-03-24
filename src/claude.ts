import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WORK_DIR, MAX_CLAUDE_WORKERS, CLAUDE_TIMEOUT_MS, MAX_COPILOT_WORKERS, COPILOT_TIMEOUT_MS, MAX_CODEX_WORKERS, CODEX_TIMEOUT_MS, type Repo } from "./config.js";
import * as log from "./log.js";
import { isShuttingDown, ShutdownError } from "./shutdown.js";

/** Generate a short random suffix for branch names (4 hex chars). */
export function randomSuffix(): string {
  return crypto.randomBytes(2).toString("hex");
}

/** Compact date string for branch names (YYYYMMDD). */
export function datestamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

// ── AI backend types ──

export type AiBackend = "claude" | "copilot" | "codex";

export interface AiOptions {
  backend?: AiBackend;
  model?: string;
}

interface BackendConfig {
  binary: string;
  args: string[];
  promptVia: "stdin" | "flag" | "positional";  // "stdin" = pipe via stdin, "flag" = pass as -p argument, "positional" = append as last arg
  name: string;
}

const BACKENDS: Record<AiBackend, BackendConfig> = {
  claude: { binary: "claude", args: ["-p", "--dangerously-skip-permissions"], promptVia: "stdin", name: "Claude" },
  copilot: { binary: "copilot", args: ["--allow-all-tools", "-s", "--no-ask-user"], promptVia: "flag", name: "Copilot" },
  codex: { binary: "codex", args: ["exec", "--full-auto"], promptVia: "positional", name: "Codex" },
};

// ── Bounded concurrent queue ──

type QueuedTask = {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  priority: boolean;
};

class BoundedQueue {
  private readonly queue: QueuedTask[] = [];
  private activeCount = 0;

  constructor(
    private readonly maxWorkers: () => number,
    private readonly name: string,
  ) {}

  private drain(): void {
    while (this.queue.length > 0 && this.activeCount < this.maxWorkers()) {
      const idx = this.queue.findIndex((t) => t.priority);
      const task = idx >= 0 ? this.queue.splice(idx, 1)[0] : this.queue.shift()!;
      this.activeCount++;
      (async () => {
        try {
          const result = await task.fn();
          task.resolve(result);
        } catch (err) {
          task.reject(err);
        } finally {
          this.activeCount--;
          this.drain();
        }
      })();
    }
  }

  status(): { pending: number; active: number } {
    return { pending: this.queue.length, active: this.activeCount };
  }

  enqueue<T>(fn: () => Promise<T>, priority = false): Promise<T> {
    if (isShuttingDown()) {
      return Promise.reject(new ShutdownError("Shutting down — task not started"));
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ fn, resolve: resolve as (v: unknown) => void, reject, priority });
      this.drain();
    });
  }

  cancel(): void {
    let count = 0;
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      task.reject(new ShutdownError("Shutting down — task cancelled"));
      count++;
    }
    if (count > 0) log.info(`Cancelled ${count} queued ${this.name} task(s)`);
  }
}

const claudeQueue = new BoundedQueue(() => MAX_CLAUDE_WORKERS, "claude");
const copilotQueue = new BoundedQueue(() => MAX_COPILOT_WORKERS, "copilot");
const codexQueue = new BoundedQueue(() => MAX_CODEX_WORKERS, "codex");

export function queueStatus(): { pending: number; active: number } {
  return claudeQueue.status();
}

export function enqueue<T>(fn: () => Promise<T>, priority = false): Promise<T> {
  return claudeQueue.enqueue(fn, priority);
}

export function cancelQueuedTasks(): void {
  claudeQueue.cancel();
  copilotQueue.cancel();
  codexQueue.cancel();
}

export function copilotQueueStatus(): { pending: number; active: number } {
  return copilotQueue.status();
}

export function enqueueCopilot<T>(fn: () => Promise<T>, priority = false): Promise<T> {
  return copilotQueue.enqueue(fn, priority);
}

export function codexQueueStatus(): { pending: number; active: number } {
  return codexQueue.status();
}

export function enqueueCodex<T>(fn: () => Promise<T>, priority = false): Promise<T> {
  if (MAX_CODEX_WORKERS <= 0) {
    return Promise.reject(new Error("Codex backend is disabled (maxCodexWorkers is 0)"));
  }
  return codexQueue.enqueue(fn, priority);
}

/** Select the correct enqueue function based on the AI backend in options. */
export function resolveEnqueue(aiOptions?: AiOptions): typeof enqueue {
  if (aiOptions?.backend === "codex") return enqueueCodex;
  if (aiOptions?.backend === "copilot") return enqueueCopilot;
  return enqueue;
}

// ── Git helpers ──

let _gitPreCallHook: (() => Promise<void>) | null = null;

/** Register a hook called before every git() invocation (used for GitHub App token refresh). */
export function setGitPreCallHook(hook: () => Promise<void>): void {
  _gitPreCallHook = hook;
}

export async function git(args: string[], cwd: string): Promise<string> {
  if (_gitPreCallHook) await _gitPreCallHook();
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr || err.message}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/** Like git() but returns { code, stdout, stderr } instead of throwing. */
function gitRaw(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && "code" in err ? (err as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function repoDir(repo: Repo): string {
  return path.join(WORK_DIR, "repos", repo.owner, repo.name);
}

/**
 * In-flight ensureClone promises, keyed by repo directory path.
 * Prevents concurrent git fetch operations on the same clone directory.
 */
const inflightClones = new Map<string, Promise<string>>();

/** Ensure a bare-ish main clone of the repo exists and is up to date. */
export async function ensureClone(repo: Repo): Promise<string> {
  const dir = repoDir(repo);
  const inflight = inflightClones.get(dir);
  if (inflight) return inflight;

  const work = (async () => {
    try {
      if (fs.existsSync(path.join(dir, ".git"))) {
        await git(["fetch", "--all", "--prune"], dir);
        await git(["checkout", `origin/${repo.defaultBranch}`, "--force"], dir);
      } else {
        fs.mkdirSync(dir, { recursive: true });
        if (_gitPreCallHook) await _gitPreCallHook();
        await new Promise<void>((resolve, reject) => {
          execFile(
            "gh",
            ["repo", "clone", repo.fullName, dir],
            (err) => (err ? reject(err) : resolve()),
          );
        });
      }
      return dir;
    } finally {
      inflightClones.delete(dir);
    }
  })();

  inflightClones.set(dir, work);
  return work;
}

/** Create a worktree on a new branch. Returns the worktree path. */
export async function createWorktree(repo: Repo, branchName: string, namespace: string): Promise<string> {
  const mainDir = await ensureClone(repo);
  const wtPath = path.join(WORK_DIR, "worktrees", repo.owner, repo.name, namespace, branchName);

  // Clean up stale worktree at this path if it exists
  if (fs.existsSync(wtPath)) {
    try {
      await git(["worktree", "remove", wtPath, "--force"], mainDir);
    } catch {
      fs.rmSync(wtPath, { recursive: true, force: true });
    }
  }

  // Delete stale local branch if it exists from a previous run
  try {
    await git(["branch", "-D", branchName], mainDir);
  } catch {
    // Branch doesn't exist, that's fine
  }

  // Prune stale worktree metadata (e.g. from other jobs whose directories were removed)
  await git(["worktree", "prune"], mainDir);

  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  await git(["worktree", "add", wtPath, "-b", branchName, "--no-track", `origin/${repo.defaultBranch}`], mainDir);
  return wtPath;
}

/** Create a worktree for an existing remote branch. Returns the worktree path. */
export async function createWorktreeFromBranch(repo: Repo, branchName: string, namespace: string): Promise<string> {
  const mainDir = await ensureClone(repo);
  const wtPath = path.join(WORK_DIR, "worktrees", repo.owner, repo.name, namespace, branchName);

  if (fs.existsSync(wtPath)) {
    try {
      await git(["worktree", "remove", wtPath, "--force"], mainDir);
    } catch {
      fs.rmSync(wtPath, { recursive: true, force: true });
    }
  }

  // Prune stale worktree metadata (e.g. from other jobs whose directories were removed)
  await git(["worktree", "prune"], mainDir);

  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  // Use --detach to avoid git's branch-lock constraint: git forbids the same
  // branch being checked out in multiple worktrees simultaneously. Detached HEAD
  // allows multiple jobs to work on the same branch concurrently.
  await git(["worktree", "add", "--detach", wtPath, `origin/${branchName}`], mainDir);
  return wtPath;
}

export async function removeWorktree(repo: Repo, wtPath: string): Promise<void> {
  const mainDir = repoDir(repo);
  try {
    await git(["worktree", "remove", wtPath, "--force"], mainDir);
  } catch {
    fs.rmSync(wtPath, { recursive: true, force: true });
    // Prune stale metadata left behind after manual directory removal
    try {
      await git(["worktree", "prune"], mainDir);
    } catch {
      // best effort
    }
  }
}

/**
 * Start a merge of origin/<baseBranch> into the current branch.
 * Returns whether the merge was clean and, if not, the list of conflicted files.
 */
export async function attemptMerge(
  wtPath: string,
  baseBranch: string,
): Promise<{ clean: boolean; conflictedFiles: string[] }> {
  const result = await gitRaw(["merge", `origin/${baseBranch}`, "--no-edit"], wtPath);
  if (result.code === 0) {
    return { clean: true, conflictedFiles: [] };
  }
  // Get list of conflicted (unmerged) files
  const unmerged = await gitRaw(["diff", "--name-only", "--diff-filter=U"], wtPath);
  const files = unmerged.stdout.split("\n").filter(Boolean);
  return { clean: false, conflictedFiles: files };
}

/** Abort an in-progress merge. */
export async function abortMerge(wtPath: string): Promise<void> {
  await gitRaw(["merge", "--abort"], wtPath);
}

/** Return the author date of a given commit. */
export async function getCommitDate(wtPath: string, sha: string): Promise<Date> {
  const iso = await git(["log", "-1", "--format=%aI", sha], wtPath);
  return new Date(iso);
}

/** Return the SHA of the most recent [doc-maintainer] commit, or null if none exists. */
export async function getLastDocMaintainerSha(wtPath: string): Promise<string | null> {
  const sha = await git(["log", "--oneline", "--grep=\\[doc-maintainer\\]", "-1", "--format=%H"], wtPath);
  return sha || null;
}

/** Return the current HEAD SHA. */
export async function getHeadSha(wtPath: string): Promise<string> {
  return git(["rev-parse", "HEAD"], wtPath);
}

/** Check if the worktree has new commits compared to origin. */
export async function hasNewCommits(wtPath: string, baseBranch: string): Promise<boolean> {
  const count = await git(["rev-list", "--count", `origin/${baseBranch}..HEAD`], wtPath);
  return parseInt(count, 10) > 0;
}

/** Check if the worktree tree actually differs from the base branch (guards against no-op commits). */
export async function hasTreeDiff(wtPath: string, baseBranch: string): Promise<boolean> {
  const result = await gitRaw(["diff", "--quiet", `origin/${baseBranch}`, "HEAD"], wtPath);
  return result.code !== 0;
}

/** Generate a PR description by asking Claude to summarize the diff and issue. */
export async function generatePRDescription(
  wtPath: string,
  baseBranch: string,
  issue: { number: number; title: string; body: string },
  aiOptions?: AiOptions,
): Promise<string> {
  const diff = await git(["diff", `origin/${baseBranch}...HEAD`], wtPath);
  const truncatedDiff = diff.slice(0, 30_000);

  const prompt = [
    `You are writing a pull request description. Here is the issue that was resolved:`,
    ``,
    `**Issue #${issue.number}: ${issue.title}**`,
    issue.body,
    ``,
    `Here is the diff of all changes made:`,
    "```",
    truncatedDiff,
    "```",
    ``,
    `Write a concise PR description in markdown. Include:`,
    `1. A "## Summary" section explaining what was done and why (2-4 sentences)`,
    `2. A "## Changes" section with a bulleted list of the key changes`,
    ``,
    `Do NOT include the raw diff or diffstat. Focus on the intent and effect of the changes.`,
  ].join("\n");

  const description = await resolveEnqueue(aiOptions)(() => runAI(prompt, wtPath, aiOptions));
  if (!description.trim()) {
    throw new Error(
      `AI returned empty PR description for issue #${issue.number}`,
    );
  }
  return description.trim();
}

/** Generate a PR description for documentation updates by asking Claude to summarize the diff. */
export async function generateDocsPRDescription(
  wtPath: string,
  baseBranch: string,
  aiOptions?: AiOptions,
): Promise<string> {
  const diff = await git(["diff", `origin/${baseBranch}...HEAD`], wtPath);
  const truncatedDiff = diff.slice(0, 30_000);

  const prompt = [
    `You are writing a pull request description for an automated documentation update.`,
    ``,
    `Here is the diff of all documentation changes made:`,
    "```",
    truncatedDiff,
    "```",
    ``,
    `Write a concise PR description in markdown. Include:`,
    `1. A "## Summary" section explaining what documentation was added or updated and why (2-4 sentences)`,
    `2. A "## Changes" section with a bulleted list of key changes (new docs, updated sections, removed content)`,
    ``,
    `Do NOT include the raw diff or diffstat. Focus on the intent and effect of the changes.`,
  ].join("\n");

  const description = await resolveEnqueue(aiOptions)(() => runAI(prompt, wtPath, aiOptions));
  if (!description.trim()) {
    throw new Error("AI returned empty PR description for docs update");
  }
  return description.trim();
}

/** Regenerate a PR description from the full diff (used after ci-fixer/review-addresser pushes). */
export async function regeneratePRDescription(
  wtPath: string,
  baseBranch: string,
  pr: { number: number; title: string },
  aiOptions?: AiOptions,
): Promise<string> {
  const diff = await git(["diff", `origin/${baseBranch}...HEAD`], wtPath);
  const truncatedDiff = diff.slice(0, 30_000);

  const prompt = [
    `You are writing a pull request description for PR #${pr.number}: ${pr.title}`,
    ``,
    `Here is the diff of all changes on this branch compared to the base branch:`,
    "```",
    truncatedDiff,
    "```",
    ``,
    `Write a concise PR description in markdown. Include:`,
    `1. A "## Summary" section explaining what was done and why (2-4 sentences)`,
    `2. A "## Changes" section with a bulleted list of the key changes`,
    ``,
    `Do NOT include the raw diff or diffstat. Focus on the intent and effect of the changes.`,
  ].join("\n");

  const description = await resolveEnqueue(aiOptions)(() => runAI(prompt, wtPath, aiOptions));
  if (!description.trim()) {
    throw new Error(`AI returned empty PR description for PR #${pr.number}`);
  }
  return description.trim();
}

/** Run an AI backend with the given prompt. Respects backend-specific binary, args, and timeout. */
export function runAI(prompt: string, cwd: string, options?: AiOptions): Promise<string> {
  const backend = options?.backend ?? "claude";
  const config = BACKENDS[backend];
  const timeoutMs = backend === "copilot" ? COPILOT_TIMEOUT_MS : backend === "codex" ? CODEX_TIMEOUT_MS : CLAUDE_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const args = [...config.args];
    if (config.promptVia === "flag") {
      args.unshift("-p", prompt);
    }
    if (options?.model) {
      args.push("--model", options.model);
    }
    // Positional prompt must come last, after all flags
    if (config.promptVia === "positional") {
      args.push(prompt);
    }

    const child = spawn(config.binary, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    activeChildren.add(child);
    const startTime = Date.now();

    let stdout = "";
    let stderr = "";

    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      log.info(`${config.name} process still running (PID ${child.pid}, elapsed ${elapsed}s, stdout ${stdout.length} bytes)`);
    }, 5 * 60 * 1000);

    let killTimer: NodeJS.Timeout | undefined;
    const timeout = setTimeout(() => {
      log.warn(`${config.name} process timed out after ${timeoutMs}ms — sending SIGTERM`);
      log.warn(`Timeout diagnostics: cwd=${cwd}, stdout=${stdout.length} bytes, stderr=${stderr.length} bytes`);
      if (stdout.length > 0) {
        log.warn(`Last stdout (up to 2000 chars):\n${stdout.slice(-2000)}`);
      } else {
        log.warn("No stdout produced before timeout — process may have been waiting for input or stuck");
      }
      timedOutChildren.add(child);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        log.warn(`${config.name} process did not exit after SIGTERM — sending SIGKILL`);
        child.kill("SIGKILL");
      }, 10_000);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) log.debug(trimmed);
      }
    });

    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearInterval(heartbeat);
      activeChildren.delete(child);
      if (timedOutChildren.has(child)) {
        reject(new AiTimeoutError(
          timeoutMs,
          stdout.length,
          stdout.slice(-3000),
          stderr.slice(-1000),
          cwd,
        ));
        return;
      }
      if (cancelledChildren.has(child) || (signal === "SIGTERM" && isShuttingDown())) {
        reject(new ShutdownError("Task cancelled — shutting down"));
        return;
      }
      if (signal) {
        log.warn(`${config.name} was killed by signal ${signal}: ${stderr.slice(0, 500)}`);
        reject(new Error(`${config.name} was killed by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        log.warn(`${config.name} exited with code ${code}: ${stderr.slice(0, 500)}`);
        reject(new Error(`${config.name} exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve(stdout);
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      clearInterval(heartbeat);
      activeChildren.delete(child);
      reject(new Error(`Failed to spawn ${config.name}: ${err.message}`));
    });

    if (config.promptVia === "stdin") {
      child.stdin.write(prompt);
    }
    child.stdin.end();  // always close stdin to signal EOF
  });
}

export async function pushBranch(wtPath: string, branchName: string): Promise<void> {
  // Use HEAD refspec to support both detached HEAD (createWorktreeFromBranch)
  // and named branch (createWorktree) worktrees.
  await git(["push", "origin", `HEAD:refs/heads/${branchName}`], wtPath);
}

// ── Claude invocation ──

export class AiTimeoutError extends Error {
  readonly lastOutput: string;
  readonly lastStderr: string;
  readonly outputBytes: number;
  readonly cwd: string;

  constructor(timeoutMs: number, outputBytes: number, lastOutput: string, lastStderr: string, cwd: string) {
    super(`AI process timed out after ${timeoutMs}ms`);
    this.name = "AiTimeoutError";
    this.outputBytes = outputBytes;
    this.lastOutput = lastOutput;
    this.lastStderr = lastStderr;
    this.cwd = cwd;
  }
}

export { AiTimeoutError as ClaudeTimeoutError };

const activeChildren = new Set<ChildProcess>();
const cancelledChildren = new WeakSet<ChildProcess>();
const timedOutChildren = new WeakSet<ChildProcess>();

export function cancelCurrentTask(): boolean {
  if (activeChildren.size === 0) return false;
  for (const child of activeChildren) {
    cancelledChildren.add(child);
    child.kill("SIGTERM");
  }
  return true;
}

