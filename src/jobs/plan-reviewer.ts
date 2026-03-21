import { LABELS, JOB_AI, type Repo } from "../config.js";
import * as gh from "../github.js";
import { isRateLimited } from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";

const PLAN_HEADER = "## Implementation Plan";
const REVIEW_HEADER = "## Plan Review";

function buildReviewPrompt(
  fullName: string,
  issue: gh.Issue,
  planBody: string,
): string {
  return [
    `You are reviewing an implementation plan for ${fullName}#${issue.number}.`,
    ``,
    `**Issue: ${issue.title}**`,
    ``,
    issue.body || "(No description provided)",
    ``,
    planBody,
    ``,
    `Your job is to find problems with this plan:`,
    `- Missing edge cases or error handling`,
    `- Files that should be modified but aren't mentioned`,
    `- Incorrect assumptions about the codebase`,
    `- Risks that aren't acknowledged`,
    `- Over-engineering or unnecessary complexity`,
    `- Missing test coverage`,
    ``,
    `If the plan is solid, say so briefly. If it has issues, list them clearly.`,
    `Read yeti/OVERVIEW.md if it exists for codebase context.`,
    `Do NOT make code changes. Only produce your review as text output.`,
  ].join("\n");
}

async function processIssue(repo: Repo, issue: gh.Issue, planComment: gh.IssueComment): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[plan-reviewer] Reviewing plan for ${fullName}#${issue.number}: ${issue.title}`);

  const taskId = db.recordTaskStart("plan-reviewer", fullName, issue.number, null);
  let wtPath: string | undefined;

  try {
    const branchName = `yeti/review-${issue.number}-${claude.randomSuffix()}`;
    wtPath = await claude.createWorktree(repo, branchName, "plan-reviewer");
    db.updateTaskWorktree(taskId, wtPath, branchName);

    const aiOptions = JOB_AI["plan-reviewer"];
    const prompt = buildReviewPrompt(fullName, issue, planComment.body);

    const enqueueFn = aiOptions?.backend === "copilot" ? claude.enqueueCopilot : claude.enqueue;
    const reviewOutput = await enqueueFn(
      () => claude.runAI(prompt, wtPath!, aiOptions),
      gh.hasPriorityLabel(issue.labels),
    );

    if (reviewOutput.trim()) {
      await gh.commentOnIssue(fullName, issue.number, `${REVIEW_HEADER}\n\n${reviewOutput}`);
      log.info(`[plan-reviewer] Posted review for ${fullName}#${issue.number}`);
    } else {
      log.warn(`[plan-reviewer] Empty review output for ${fullName}#${issue.number}`);
    }

    // Mark plan comment as processed
    await gh.addReaction(fullName, planComment.id, "+1");

    // Transition labels: remove Needs Plan Review, add Ready
    await gh.removeLabel(fullName, issue.number, LABELS.needsPlanReview);
    await gh.addLabel(fullName, issue.number, LABELS.ready);

    db.recordTaskComplete(taskId);
  } catch (err) {
    db.recordTaskFailed(taskId, String(err));
    throw err;
  } finally {
    if (wtPath) {
      await claude.removeWorktree(repo, wtPath);
    }
  }
}

export async function run(repos: Repo[]): Promise<void> {
  const tasks: Promise<void>[] = [];

  for (const repo of repos) {
    if (isRateLimited()) break;
    try {
      const issues = await gh.listOpenIssues(repo.fullName);
      const selfLogin = await gh.getSelfLogin();

      for (const issue of issues) {
        if (isRateLimited()) break;
        if (gh.isItemSkipped(repo.fullName, issue.number)) continue;

        // Only process issues with the Needs Plan Review label
        if (!issue.labels.some((l) => l.name === LABELS.needsPlanReview)) continue;

        // Skip issues with Refined label (being implemented)
        if (issue.labels.some((l) => l.name === LABELS.refined)) continue;

        // Find the most recent plan comment
        const comments = await gh.getIssueComments(repo.fullName, issue.number);
        const planComment = comments.findLast(
          (c) => c.body.includes(PLAN_HEADER) && gh.isYetiComment(c.body),
        );

        if (!planComment) continue;

        // Check if we already reviewed this plan (thumbsup reaction from us)
        try {
          const reactions = await gh.getCommentReactions(repo.fullName, planComment.id);
          const alreadyReviewed = reactions.some(
            (r) => r.user.login === selfLogin && r.content === "+1",
          );
          if (alreadyReviewed) continue;
        } catch {
          // If we can't check reactions, skip to be safe
          continue;
        }

        gh.populateQueueCache("needs-plan-review", repo.fullName, {
          number: issue.number,
          title: issue.title,
          type: "issue",
          updatedAt: issue.updatedAt,
          priority: gh.hasPriorityLabel(issue.labels),
        });

        tasks.push(
          processIssue(repo, issue, planComment).catch((err) =>
            reportError("plan-reviewer:process-issue", `${repo.fullName}#${issue.number}`, err),
          ),
        );
      }
    } catch (err) {
      reportError("plan-reviewer:list-issues", repo.fullName, err);
    }
  }

  await Promise.allSettled(tasks);
}
