import { LABELS, JOB_AI, REVIEW_LOOP, MAX_PLAN_ROUNDS, repoAutonomy, type Repo } from "../config.js";
import * as gh from "../github.js";
import { isRateLimited } from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";
import { notify } from "../notify.js";
import { PLAN_HEADER } from "../plan-parser.js";
import { renderPolicy, type Autonomy } from "../policy.js";
import { stripLearningsDeclaration } from "../learnings.js";
import {
  REVIEW_HEADER,
  reviewMarker,
  findReviewOfPlanVersion,
  parseVerdict,
  renderVerdict,
  countPlanRounds,
  countSegments,
} from "../review-contract.js";

export function buildThreadSection(comments: gh.IssueComment[], planCommentId: number): string {
  const rest = comments.filter((c) => c.id !== planCommentId);
  if (rest.length === 0) return "(No other comments on the issue.)";
  return rest
    .map((c) => {
      const label = gh.isYetiComment(c.body)
        ? `Comment by @${c.login} (automated by Yeti):`
        : c.login.endsWith("[bot]")
          ? `Comment by @${c.login} (bot):`
          : `MAINTAINER (binding) — comment by @${c.login}:`;
      return ["---", label, gh.stripYetiMarker(c.body), ""].join("\n");
    })
    .join("\n");
}

export function buildRoundInfo(round: number, maxRounds: number): string {
  const base = `This is review round ${round} of ${maxRounds}.`;
  if (round >= maxRounds) {
    return `${base} This is the final round: if nothing rises to Blocking, approve — do not manufacture findings.`;
  }
  return base;
}

export function buildReviewPrompt(
  autonomy: Autonomy,
  fullName: string,
  issue: gh.Issue,
  planBody: string,
  threadSection: string,
  roundInfo: string,
  segment: number,
): string {
  const roundNumber = roundInfo.match(/round (\d+)/)?.[1] ?? "1";
  const findingPrefix = segment > 1 ? `S${segment}-R${roundNumber}` : `R${roundNumber}`;
  return renderPolicy("plan-reviewer", autonomy, {
    FULL_NAME: fullName,
    ISSUE_NUMBER: String(issue.number),
    ISSUE_TITLE: issue.title,
    ISSUE_BODY: issue.body || "(No description provided)",
    PLAN_BODY: planBody,
    THREAD_SECTION: threadSection,
    ROUND_INFO: roundInfo,
    SEGMENT_NUMBER: String(segment),
    FINDING_PREFIX: findingPrefix,
  });
}

async function processIssue(repo: Repo, issue: gh.Issue, planComment: gh.IssueComment, comments: gh.IssueComment[]): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[plan-reviewer] Reviewing plan for ${fullName}#${issue.number}: ${issue.title}`);

  const taskId = db.recordTaskStart("plan-reviewer", fullName, issue.number, null);
  let wtPath: string | undefined;

  try {
    const branchName = `yeti/review-${issue.number}-${claude.randomSuffix()}`;
    wtPath = await claude.createWorktree(repo, branchName, "plan-reviewer");
    db.updateTaskWorktree(taskId, wtPath, branchName);

    const aiOptions = JOB_AI["plan-reviewer"];
    const round = countPlanRounds(comments) + 1;
    const segment = countSegments(comments);
    const prompt = buildReviewPrompt(
      repoAutonomy(repo), fullName, issue, planComment.body,
      buildThreadSection(comments, planComment.id),
      buildRoundInfo(round, MAX_PLAN_ROUNDS),
      segment,
    );

    const reviewOutput = await claude.resolveEnqueue(aiOptions)(
      () => claude.runAI(prompt, wtPath!, aiOptions),
      gh.hasPriorityLabel(issue.labels),
    );

    if (!reviewOutput.trim()) {
      log.warn(`[plan-reviewer] Empty review output for ${fullName}#${issue.number} — will retry next cycle`);
      db.recordTaskFailed(taskId, "Empty review output");
      return;
    }

    const rendered = renderVerdict(stripLearningsDeclaration(reviewOutput));
    const scrubbed = claude.scrubWorktreePaths(rendered, wtPath);
    const marker = reviewMarker(planComment.id, planComment.updatedAt);
    await gh.commentOnIssue(fullName, issue.number, `${REVIEW_HEADER}\n\n${scrubbed}\n\n${marker}`);
    log.info(`[plan-reviewer] Posted review for ${fullName}#${issue.number}`);
    notify({ jobName: "plan-reviewer", message: `Review posted for ${fullName}#${issue.number}`, url: gh.issueUrl(fullName, issue.number) });

    if (REVIEW_LOOP) {
      const parsed = parseVerdict(reviewOutput);
      if (parsed === "missing") {
        log.warn(`[plan-reviewer] No verdict line in review for ${fullName}#${issue.number} — treating as needs-revision`);
      }
      const verdict = parsed === "approved" ? "approved" : "needs-revision";
      if (verdict === "approved") {
        await gh.removeLabel(fullName, issue.number, LABELS.needsPlanReview);
        await gh.addLabel(fullName, issue.number, LABELS.ready);
      } else {
        if (round >= MAX_PLAN_ROUNDS) {
          await gh.commentOnIssue(
            fullName,
            issue.number,
            `⚠️ Maximum plan review rounds (${MAX_PLAN_ROUNDS}) reached. The plan may still need work — please review manually.`,
          );
          await gh.removeLabel(fullName, issue.number, LABELS.needsPlanReview);
          await gh.addLabel(fullName, issue.number, LABELS.ready);
        } else {
          await gh.removeLabel(fullName, issue.number, LABELS.needsPlanReview);
          await gh.addLabel(fullName, issue.number, LABELS.needsRefinement);
        }
      }
    } else {
      // Default behavior: always transition to Ready
      await gh.removeLabel(fullName, issue.number, LABELS.needsPlanReview);
      await gh.addLabel(fullName, issue.number, LABELS.ready);
    }

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

        // Skip if this exact plan version already has a review (identity-independent,
        // re-arms automatically when the plan comment is edited in place).
        if (findReviewOfPlanVersion(comments, planComment.id, planComment.updatedAt)) continue;

        gh.populateQueueCache("needs-plan-review", repo.fullName, {
          number: issue.number,
          title: issue.title,
          type: "issue",
          updatedAt: issue.updatedAt,
          priority: gh.hasPriorityLabel(issue.labels),
        });

        tasks.push(
          processIssue(repo, issue, planComment, comments).catch((err) =>
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
