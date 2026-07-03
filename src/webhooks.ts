import crypto from "node:crypto";
import { LABELS, ALLOWED_REPOS, GITHUB_OWNERS, SELF_REPO } from "./config.js";
import { LABEL_TO_CATEGORY, populateQueueCache, removeQueueCacheEntry, removeQueueItem, updateQueueItemPriority, hasPriorityLabel, isRepoNameAllowed, getSelfLogin } from "./github.js";
import type { Scheduler } from "./scheduler.js";
import * as log from "./log.js";

// ── HMAC signature verification ──

export function verifyWebhookSignature(secret: string, payload: Buffer, signature: string): boolean {
  if (!signature || !signature.startsWith("sha256=")) return false;

  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(payload).digest("hex");
  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signature);

  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

// ── Repo filtering ──

export function isRepoAllowed(repoFullName: string): boolean {
  const repoName = repoFullName.split("/").pop()!.toLowerCase();
  const owner = repoFullName.split("/")[0];

  // When an explicit allowlist is configured, use the shared check
  if (ALLOWED_REPOS !== null) return isRepoNameAllowed(repoName);

  // No allowlist — allow self-repo or any repo from configured owners
  if (repoFullName.toLowerCase() === SELF_REPO.toLowerCase()) return true;
  return GITHUB_OWNERS.some((o) => o.toLowerCase() === owner.toLowerCase());
}

// ── Label → job mapping ──

const LABEL_TO_JOB: Record<string, string> = {
  [LABELS.refined]: "issue-worker",
  [LABELS.needsRefinement]: "issue-refiner",
  [LABELS.needsPlanReview]: "plan-reviewer",
};

// ── Webhook event handler ──

export async function handleWebhookEvent(event: string, payload: unknown, scheduler: Scheduler): Promise<{ action: string }> {
  if (event === "ping") return { action: "pong" };

  const p = payload as Record<string, unknown>;

  if (event === "issues") {
    return handleIssuesEvent(p, scheduler);
  }

  if (event === "check_run") {
    return handleCheckRunEvent(p, scheduler);
  }

  if (event === "pull_request_review") {
    return handlePullRequestReviewEvent(p, scheduler);
  }

  if (event === "pull_request") {
    return handlePullRequestEvent(p);
  }

  if (event === "issue_comment") {
    return handleIssueCommentEvent(p, scheduler);
  }

  if (event === "pull_request_review_comment") {
    return handlePullRequestReviewCommentEvent(p, scheduler);
  }

  return { action: "ignored" };
}

function triggerJob(jobName: string, scheduler: Scheduler): { action: string; result: string } {
  const result = scheduler.triggerJob(jobName);

  if (result === "started") return { action: `triggered:${jobName}`, result };
  if (result === "already-running") return { action: "skipped:already-running", result };
  return { action: "skipped:job-not-enabled", result };
}

// ── Issues event handler ──

function handleIssuesEvent(p: Record<string, unknown>, scheduler: Scheduler): { action: string } {
  const action = p.action as string | undefined;
  if (action !== "labeled" && action !== "unlabeled") return { action: "ignored" };

  const label = (p.label as { name?: string } | undefined)?.name;
  const repo = (p.repository as { full_name?: string } | undefined)?.full_name;
  const issue = p.issue as { number?: number; title?: string; updated_at?: string; labels?: { name: string }[] } | undefined;

  if (!label || !repo || !issue?.number) {
    return { action: "ignored" };
  }

  if (!isRepoAllowed(repo)) {
    log.info(`[webhook] Skipping issues event from ${repo} — not in allowed repos`);
    return { action: "skipped:not-allowed-repo" };
  }

  const { number, title, updated_at, labels } = issue;

  if (action === "labeled") {
    return handleLabeled(label, repo, number, title, updated_at, labels, scheduler);
  }

  // unlabeled
  return handleUnlabeled(label, repo, number);
}

function handleLabeled(
  label: string,
  repo: string,
  number: number,
  title: string | undefined,
  updatedAt: string | undefined,
  labels: { name: string }[] | undefined,
  scheduler: Scheduler,
): { action: string } {
  const category = LABEL_TO_CATEGORY[label];
  const priority = hasPriorityLabel(labels ?? []);

  // Handle Priority label — update existing cache entries
  if (label === LABELS.priority) {
    updateQueueItemPriority(repo, number, true);
    log.info(`[webhook] Updated priority for ${repo}#${number}`);
    return { action: "cache-updated" };
  }

  // Handle queue labels — update cache + optionally trigger job
  if (category) {
    populateQueueCache(category, repo, {
      number,
      title: title ?? "",
      type: "issue",
      updatedAt,
      priority,
    });

    const jobName = LABEL_TO_JOB[label];
    if (!jobName) {
      log.info(`[webhook] Cache updated for ${repo}#${number} (${label})`);
      return { action: "cache-updated" };
    }

    const { action, result } = triggerJob(jobName, scheduler);
    log.info(`[webhook] ${label} on ${repo}#${number} → ${jobName}: ${result}`);
    return { action };
  }

  return { action: "ignored" };
}

function handleUnlabeled(label: string, repo: string, number: number): { action: string } {
  if (label === LABELS.priority) {
    updateQueueItemPriority(repo, number, false);
    log.info(`[webhook] Cleared priority for ${repo}#${number}`);
    return { action: "cache-updated" };
  }

  const category = LABEL_TO_CATEGORY[label];
  if (category) {
    removeQueueCacheEntry(category, repo, number);
    log.info(`[webhook] Removed ${category} cache entry for ${repo}#${number}`);
    return { action: "cache-updated" };
  }

  return { action: "ignored" };
}

// ── Check run event handler ──

function handleCheckRunEvent(p: Record<string, unknown>, scheduler: Scheduler): { action: string } {
  if (p.action !== "completed") return { action: "ignored" };

  const checkRun = p.check_run as { conclusion?: string; pull_requests?: unknown[] } | undefined;
  const repo = (p.repository as { full_name?: string } | undefined)?.full_name;

  if (!checkRun?.conclusion || !repo) return { action: "ignored" };

  if (!isRepoAllowed(repo)) {
    log.info(`[webhook] Skipping check_run from ${repo} — not in allowed repos`);
    return { action: "skipped:not-allowed-repo" };
  }

  const conclusion = checkRun.conclusion;
  if (conclusion !== "failure" && conclusion !== "timed_out") return { action: "ignored" };

  // Skip check runs not associated with a PR
  if (!checkRun.pull_requests || checkRun.pull_requests.length === 0) return { action: "ignored" };

  const { action, result } = triggerJob("ci-fixer", scheduler);
  log.info(`[webhook] check_run ${conclusion} on ${repo} → ci-fixer: ${result}`);
  return { action };
}

// ── Pull request review event handler ──

function handlePullRequestReviewEvent(p: Record<string, unknown>, scheduler: Scheduler): { action: string } {
  if (p.action !== "submitted") return { action: "ignored" };

  const review = p.review as { state?: string } | undefined;
  if (review?.state !== "approved") return { action: "ignored" };

  const repo = (p.repository as { full_name?: string } | undefined)?.full_name;
  const pr = p.pull_request as { number?: number; head?: { ref?: string }; user?: { login?: string } } | undefined;

  if (!repo || !pr?.number) return { action: "ignored" };

  if (!isRepoAllowed(repo)) {
    log.info(`[webhook] Skipping pull_request_review from ${repo} — not in allowed repos`);
    return { action: "skipped:not-allowed-repo" };
  }

  // Only trigger for PR types that auto-merger actually processes
  const headRef = pr.head?.ref ?? "";
  const author = pr.user?.login ?? "";
  const isYetiPR = headRef.startsWith("yeti/issue-") || headRef.startsWith("yeti/improve-");
  if (!isYetiPR && author !== "dependabot[bot]") return { action: "ignored" };

  const { action, result } = triggerJob("auto-merger", scheduler);
  log.info(`[webhook] pull_request_review approved on ${repo}#${pr.number} → auto-merger: ${result}`);
  return { action };
}

// ── Pull request event handler ──

function handlePullRequestEvent(p: Record<string, unknown>): { action: string } {
  if (p.action !== "closed") return { action: "ignored" };

  const repo = (p.repository as { full_name?: string } | undefined)?.full_name;
  const pr = p.pull_request as { number?: number } | undefined;

  if (!repo || !pr?.number) return { action: "ignored" };

  if (!isRepoAllowed(repo)) {
    log.info(`[webhook] Skipping pull_request from ${repo} — not in allowed repos`);
    return { action: "skipped:not-allowed-repo" };
  }

  removeQueueItem(repo, pr.number);
  log.info(`[webhook] Removed queue entries for ${repo}#${pr.number} (PR closed)`);
  return { action: "cache-updated" };
}

// ── Comment event handlers ──

async function isSelfOrBot(author: string | undefined): Promise<boolean> {
  if (!author) return true;
  if (author.toLowerCase().endsWith("[bot]")) return true;

  const selfLogin = await getSelfLogin();
  return author.toLowerCase() === selfLogin.toLowerCase();
}

async function handleIssueCommentEvent(p: Record<string, unknown>, scheduler: Scheduler): Promise<{ action: string }> {
  if (p.action !== "created") return { action: "ignored" };

  const repo = (p.repository as { full_name?: string } | undefined)?.full_name;
  const issue = p.issue as { number?: number; pull_request?: unknown } | undefined;
  const author = (p.comment as { user?: { login?: string } } | undefined)?.user?.login;

  if (!repo || !issue?.number) return { action: "ignored" };

  if (!isRepoAllowed(repo)) {
    log.info(`[webhook] Skipping issue_comment from ${repo} — not in allowed repos`);
    return { action: "skipped:not-allowed-repo" };
  }

  if (await isSelfOrBot(author)) {
    log.info(`[webhook] Skipping issue_comment from ${repo}#${issue.number} — self/bot author`);
    return { action: "skipped:self-or-bot" };
  }

  const isPullRequestConversation = Object.prototype.hasOwnProperty.call(issue, "pull_request");
  const jobName = isPullRequestConversation ? "review-addresser" : "issue-refiner";
  const { action, result } = triggerJob(jobName, scheduler);
  log.info(`[webhook] issue_comment created on ${repo}#${issue.number} → ${jobName}: ${result}`);
  return { action };
}

async function handlePullRequestReviewCommentEvent(p: Record<string, unknown>, scheduler: Scheduler): Promise<{ action: string }> {
  if (p.action !== "created") return { action: "ignored" };

  const repo = (p.repository as { full_name?: string } | undefined)?.full_name;
  const pr = p.pull_request as { number?: number } | undefined;
  const author = (p.comment as { user?: { login?: string } } | undefined)?.user?.login;

  if (!repo || !pr?.number) return { action: "ignored" };

  if (!isRepoAllowed(repo)) {
    log.info(`[webhook] Skipping pull_request_review_comment from ${repo} — not in allowed repos`);
    return { action: "skipped:not-allowed-repo" };
  }

  if (await isSelfOrBot(author)) {
    log.info(`[webhook] Skipping pull_request_review_comment from ${repo}#${pr.number} — self/bot author`);
    return { action: "skipped:self-or-bot" };
  }

  const { action, result } = triggerJob("review-addresser", scheduler);
  log.info(`[webhook] pull_request_review_comment created on ${repo}#${pr.number} → review-addresser: ${result}`);
  return { action };
}
