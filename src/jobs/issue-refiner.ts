import { LABELS, ENABLED_JOBS, JOB_AI, repoAutonomy, type Repo } from "../config.js";
import * as gh from "../github.js";
import { isRateLimited } from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";
import { notify } from "../notify.js";
import { processTextForImages } from "../images.js";
import { extractFingerprint, REPORT_HEADER as YETI_ERROR_REPORT_HEADER } from "./triage-yeti-errors.js";
import { PLAN_HEADER, isPlanActionable } from "../plan-parser.js";
import { renderPolicy, type Autonomy } from "../policy.js";
import { stripLearningsDeclaration } from "../learnings.js";
import { findReviewOfPlanVersion } from "../review-contract.js";

const EMPTY_REVISION_ERROR = "Empty revision output";
const MAX_EMPTY_REVISION_RETRIES = 3;

function isCiUnrelatedIssue(issue: gh.Issue): boolean {
  return issue.title.startsWith("[ci-unrelated]");
}

function consecutiveEmptyRevisions(fullName: string, issueNumber: number): number {
  const tasks = db.getRecentTasksForItem("issue-refiner", fullName, issueNumber);
  let count = 0;
  for (const task of tasks) {
    if (task.status === "running") continue;
    if (task.status === "failed" && task.error === EMPTY_REVISION_ERROR) {
      count++;
      continue;
    }
    break;
  }
  return count;
}

export function buildRefinementPrompt(
  autonomy: Autonomy,
  fullName: string,
  issue: gh.Issue,
  existingPlan: string,
  feedback: gh.IssueComment[],
): string {
  const feedbackSection = feedback.length > 0
    ? [
        `The following feedback was provided on the plan:`,
        ``,
        ...feedback.flatMap((f) => {
          const label = gh.isYetiComment(f.body)
            ? `Comment by @${f.login} (automated by Yeti):`
            : `Comment by @${f.login}:`;
          return [`---`, label, gh.stripYetiMarker(f.body), ``];
        }),
      ].join("\n")
    : [`No specific feedback comments were provided. Re-evaluate the plan for:`,
        `- Missing files or changes that should be included`,
        `- Edge cases or risks not yet addressed`,
        `- Whether the implementation order is correct`,
        `- Whether the testing approach is sufficient`,
        ``].join("\n");

  return renderPolicy("issue-refiner.refine", autonomy, {
    FULL_NAME: fullName,
    ISSUE_NUMBER: String(issue.number),
    ISSUE_TITLE: issue.title,
    ISSUE_BODY: issue.body || "(No description provided)",
    EXISTING_PLAN: existingPlan,
    FEEDBACK_SECTION: feedbackSection,
  });
}

export function buildReviseFromReviewPrompt(
  autonomy: Autonomy,
  fullName: string,
  issue: gh.Issue,
  existingPlan: string,
  reviewBody: string,
): string {
  return renderPolicy("issue-refiner.revise", autonomy, {
    FULL_NAME: fullName,
    ISSUE_NUMBER: String(issue.number),
    ISSUE_TITLE: issue.title,
    ISSUE_BODY: issue.body || "(No description provided)",
    EXISTING_PLAN: existingPlan,
    REVIEW_BODY: reviewBody,
  });
}

export function buildFollowUpPrompt(
  autonomy: Autonomy,
  fullName: string,
  issue: gh.Issue,
  existingPlan: string,
  openPRNumber: number,
  followUpComments: gh.IssueComment[],
): string {
  const followUpSection = [
    `The following follow-up comments were posted after the plan:`,
    ``,
    ...followUpComments.flatMap((f) => {
      const label = gh.isYetiComment(f.body)
        ? `Comment by @${f.login} (automated by Yeti):`
        : `Comment by @${f.login}:`;
      return [`---`, label, gh.stripYetiMarker(f.body), ``];
    }),
    ``,
  ].join("\n");

  return renderPolicy("issue-refiner.followup", autonomy, {
    FULL_NAME: fullName,
    ISSUE_NUMBER: String(issue.number),
    ISSUE_TITLE: issue.title,
    ISSUE_BODY: issue.body || "(No description provided)",
    OPEN_PR_NUMBER: String(openPRNumber),
    EXISTING_PLAN: existingPlan,
    FOLLOWUP_SECTION: followUpSection,
  });
}

export function buildNewPlanPrompt(autonomy: Autonomy, fullName: string, issue: gh.Issue, comments: gh.IssueComment[]): string {
  const commentsSection = comments.length === 0
    ? ""
    : comments.map((c) => {
        const label = gh.isYetiComment(c.body)
          ? `Comment by @${c.login} (automated by Yeti):`
          : `Comment by @${c.login}:`;
        return [`---`, label, gh.stripYetiMarker(c.body), ``].join("\n");
      }).join("\n") + "\n";

  return renderPolicy("issue-refiner", autonomy, {
    FULL_NAME: fullName,
    ISSUE_NUMBER: String(issue.number),
    ISSUE_TITLE: issue.title,
    ISSUE_BODY: issue.body || "(No description provided)",
    COMMENTS_SECTION: commentsSection,
  });
}

async function processIssue(repo: Repo, issue: gh.Issue): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[issue-refiner] Planning ${fullName}#${issue.number}: ${issue.title}`);

  const taskId = db.recordTaskStart("issue-refiner", fullName, issue.number, null);
  let wtPath: string | undefined;

  try {
    const branchName = `yeti/plan-${issue.number}-${claude.randomSuffix()}`;
    wtPath = await claude.createWorktree(repo, branchName, "issue-refiner");
    db.updateTaskWorktree(taskId, wtPath, branchName);

    const comments = await gh.getIssueComments(fullName, issue.number);
    const aiOptions = JOB_AI["issue-refiner"];
    const imageContext = await processTextForImages([issue.body, ...comments.map((c) => c.body)], wtPath);
    const prompt = buildNewPlanPrompt(repoAutonomy(repo), fullName, issue, comments) + imageContext;

    const planOutput = await claude.resolveEnqueue(aiOptions)(() => claude.runAI(prompt, wtPath!, aiOptions), gh.hasPriorityLabel(issue.labels));

    if (planOutput.trim()) {
      await gh.commentOnIssue(fullName, issue.number, `${PLAN_HEADER}\n\n${claude.scrubWorktreePaths(stripLearningsDeclaration(planOutput), wtPath)}`);
      log.info(`[issue-refiner] Posted plan for ${fullName}#${issue.number}`);
      notify({ jobName: "issue-refiner", message: `Plan produced for ${fullName}#${issue.number}`, url: gh.issueUrl(fullName, issue.number) });
    } else {
      log.warn(`[issue-refiner] Empty plan output for ${fullName}#${issue.number}`);
    }

    const actionable = isPlanActionable(planOutput);
    if (actionable) {
      if (ENABLED_JOBS.includes("plan-reviewer")) {
        await gh.addLabel(fullName, issue.number, LABELS.needsPlanReview);
      } else {
        await gh.addLabel(fullName, issue.number, LABELS.ready);
      }
    }
    // If not actionable: no label — issue waits for human response.
    await gh.removeLabel(fullName, issue.number, LABELS.needsRefinement);

    if (isCiUnrelatedIssue(issue) && actionable) {
      await gh.addLabel(fullName, issue.number, LABELS.refined);
      log.info(`[issue-refiner] Auto-refined ci-unrelated issue ${fullName}#${issue.number}`);
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

async function processRefinement(
  repo: Repo,
  issue: gh.Issue,
  unreactedComments: gh.IssueComment[],
): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[issue-refiner] Refining plan for ${fullName}#${issue.number}: ${issue.title}`);

  const taskId = db.recordTaskStart("issue-refiner", fullName, issue.number, null);
  let wtPath: string | undefined;

  const aiOptions = JOB_AI["issue-refiner"];

  try {
    const branchName = `yeti/plan-${issue.number}-${claude.randomSuffix()}`;
    wtPath = await claude.createWorktree(repo, branchName, "issue-refiner");
    db.updateTaskWorktree(taskId, wtPath, branchName);

    const comments = await gh.getIssueComments(fullName, issue.number);
    const lastPlanIdx = comments.findLastIndex((c) => c.body.includes(PLAN_HEADER));

    let refinedOutput = "";

    if (lastPlanIdx === -1) {
      log.warn(`[issue-refiner] No plan comment found for ${fullName}#${issue.number}, posting fresh plan`);
      const imageContext = await processTextForImages([issue.body, ...comments.map((c) => c.body)], wtPath);
      const prompt = buildNewPlanPrompt(repoAutonomy(repo), fullName, issue, comments) + imageContext;
      const planOutput = await claude.resolveEnqueue(aiOptions)(() => claude.runAI(prompt, wtPath!, aiOptions), gh.hasPriorityLabel(issue.labels));
      refinedOutput = planOutput;

      if (planOutput.trim()) {
        await gh.commentOnIssue(fullName, issue.number, `${PLAN_HEADER}\n\n${stripLearningsDeclaration(planOutput)}`);
        log.info(`[issue-refiner] Posted fresh plan for ${fullName}#${issue.number}`);
        notify({ jobName: "issue-refiner", message: `Plan produced for ${fullName}#${issue.number}`, url: gh.issueUrl(fullName, issue.number) });
      } else {
        log.warn(`[issue-refiner] Empty plan output for ${fullName}#${issue.number}`);
      }
    } else {
      const planComment = comments[lastPlanIdx];
      const feedback = unreactedComments;

      const imageContext = await processTextForImages([issue.body], wtPath);
      const prompt = buildRefinementPrompt(repoAutonomy(repo), fullName, issue, planComment.body, feedback) + imageContext;
      const planOutput = await claude.resolveEnqueue(aiOptions)(() => claude.runAI(prompt, wtPath!, aiOptions), gh.hasPriorityLabel(issue.labels));
      refinedOutput = planOutput;

      if (planOutput.trim()) {
        // Check for "### Note" section to post separately
        const noteMatch = planOutput.match(/### Note\s*\n([\s\S]*)$/);
        const planBody = noteMatch
          ? planOutput.slice(0, noteMatch.index).trim()
          : planOutput;

        await gh.editIssueComment(fullName, planComment.id, `${PLAN_HEADER}\n\n${claude.scrubWorktreePaths(stripLearningsDeclaration(planBody), wtPath)}`);
        log.info(`[issue-refiner] Updated plan comment for ${fullName}#${issue.number}`);
        notify({ jobName: "issue-refiner", message: `Plan updated for ${fullName}#${issue.number}`, url: gh.issueUrl(fullName, issue.number) });

        if (noteMatch) {
          await gh.commentOnIssue(fullName, issue.number, `### Note\n${claude.scrubWorktreePaths(noteMatch[1].trim(), wtPath)}`);
          log.info(`[issue-refiner] Posted note comment for ${fullName}#${issue.number}`);
        }
      } else {
        log.warn(`[issue-refiner] Empty plan output for ${fullName}#${issue.number}`);
      }
    }

    // React 👍 to each addressed comment
    for (const comment of unreactedComments) {
      await gh.addReaction(fullName, comment.id, "+1");
    }

    const actionable = isPlanActionable(refinedOutput);
    if (actionable) {
      if (ENABLED_JOBS.includes("plan-reviewer")) {
        await gh.addLabel(fullName, issue.number, LABELS.needsPlanReview);
      } else {
        await gh.addLabel(fullName, issue.number, LABELS.ready);
      }
    }
    // If not actionable: no label — issue waits for human response.
    await gh.removeLabel(fullName, issue.number, LABELS.needsRefinement);
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

async function processReviewRevision(
  repo: Repo,
  issue: gh.Issue,
  planComment: gh.IssueComment,
  reviewComment: gh.IssueComment,
): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[issue-refiner] Revising plan from review for ${fullName}#${issue.number}: ${issue.title}`);

  const taskId = db.recordTaskStart("issue-refiner", fullName, issue.number, null);
  let wtPath: string | undefined;
  const aiOptions = JOB_AI["issue-refiner"];

  try {
    const branchName = `yeti/plan-${issue.number}-${claude.randomSuffix()}`;
    wtPath = await claude.createWorktree(repo, branchName, "issue-refiner");
    db.updateTaskWorktree(taskId, wtPath, branchName);

    const prompt = buildReviseFromReviewPrompt(
      repoAutonomy(repo), fullName, issue,
      gh.stripYetiMarker(planComment.body), gh.stripYetiMarker(reviewComment.body),
    );
    const planOutput = await claude.resolveEnqueue(aiOptions)(
      () => claude.runAI(prompt, wtPath!, aiOptions),
      gh.hasPriorityLabel(issue.labels),
    );

    if (!planOutput.trim()) {
      const attempts = consecutiveEmptyRevisions(fullName, issue.number) + 1;
      if (attempts >= MAX_EMPTY_REVISION_RETRIES) {
        log.warn(`[issue-refiner] Empty revision output for ${fullName}#${issue.number} - escalating after ${attempts} attempts`);
        await gh.removeLabel(fullName, issue.number, LABELS.needsRefinement);
        await gh.addLabel(fullName, issue.number, LABELS.ready);
        await gh.commentOnIssue(
          fullName,
          issue.number,
          `Warning: the plan revision produced no output ${attempts} times in a row after plan review. ` +
            `Automatic revision has been paused and this issue has been routed to **${LABELS.ready}** for human review. ` +
            `Please address the review feedback manually, or re-add **${LABELS.needsRefinement}** to retry.`,
        );
        await reportError(
          "issue-refiner:empty-revision",
          `${fullName}#${issue.number}`,
          new Error(`processReviewRevision produced empty output ${attempts} consecutive times`),
        );
        db.recordTaskFailed(taskId, `Empty revision output - escalated after ${attempts} attempts`);
        return;
      }
      log.warn(`[issue-refiner] Empty revision output for ${fullName}#${issue.number}`);
      db.recordTaskFailed(taskId, EMPTY_REVISION_ERROR);
      return;
    }

    // Split the Review Response into its own comment so the plan stays clean.
    const respMatch = planOutput.match(/### Review Response\s*\n([\s\S]*)$/);
    const planBody = respMatch ? planOutput.slice(0, respMatch.index).trim() : planOutput;

    const actionable = isPlanActionable(planOutput);
    if (actionable) {
      const scrubbedPlan = claude.scrubWorktreePaths(stripLearningsDeclaration(planBody), wtPath);
      await gh.editIssueComment(fullName, planComment.id, `${PLAN_HEADER}\n\n${scrubbedPlan}`);
      log.info(`[issue-refiner] Revised plan comment for ${fullName}#${issue.number}`);
      notify({ jobName: "issue-refiner", message: `Plan revised after review for ${fullName}#${issue.number}`, url: gh.issueUrl(fullName, issue.number) });
    } else {
      // Blocking clarifying questions: post them so the human sees them, even if the AI
      // (violating the revise policy) also emitted a Review Response section alongside them.
      await gh.commentOnIssue(fullName, issue.number, claude.scrubWorktreePaths(stripLearningsDeclaration(planBody), wtPath));
    }
    if (respMatch) {
      const scrubbedResp = claude.scrubWorktreePaths(stripLearningsDeclaration(respMatch[1].trim()), wtPath);
      await gh.commentOnIssue(fullName, issue.number, `### Review Response\n${scrubbedResp}`);
    }

    await gh.removeLabel(fullName, issue.number, LABELS.needsRefinement);
    if (actionable) {
      await gh.addLabel(fullName, issue.number, LABELS.needsPlanReview);
    }
    // Not actionable: no label — issue waits for human answers.

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

async function processFollowUp(
  repo: Repo,
  issue: gh.Issue,
  openPRNumber: number,
  unreactedComments: gh.IssueComment[],
): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[issue-refiner] Responding to follow-up on ${fullName}#${issue.number}: ${issue.title}`);

  const taskId = db.recordTaskStart("issue-refiner", fullName, issue.number, null);
  const aiOptions = JOB_AI["issue-refiner"];
  let wtPath: string | undefined;

  try {
    const branchName = `yeti/plan-${issue.number}-${claude.randomSuffix()}`;
    wtPath = await claude.createWorktree(repo, branchName, "issue-refiner");
    db.updateTaskWorktree(taskId, wtPath, branchName);

    const comments = await gh.getIssueComments(fullName, issue.number);
    const lastPlanIdx = comments.findLastIndex(
      (c) => c.body.includes(PLAN_HEADER) && gh.isYetiComment(c.body),
    );

    if (lastPlanIdx === -1) {
      log.warn(`[issue-refiner] No plan comment found for follow-up on ${fullName}#${issue.number}, skipping`);
      db.recordTaskComplete(taskId);
      return;
    }

    const planComment = comments[lastPlanIdx];
    const imageContext = await processTextForImages([issue.body], wtPath);
    const prompt = buildFollowUpPrompt(repoAutonomy(repo), fullName, issue, planComment.body, openPRNumber, unreactedComments) + imageContext;

    const response = await claude.resolveEnqueue(aiOptions)(() => claude.runAI(prompt, wtPath!, aiOptions), gh.hasPriorityLabel(issue.labels));

    if (response.trim()) {
      await gh.commentOnIssue(fullName, issue.number, stripLearningsDeclaration(response));
      log.info(`[issue-refiner] Posted follow-up response for ${fullName}#${issue.number}`);
    } else {
      log.warn(`[issue-refiner] Empty follow-up response for ${fullName}#${issue.number}`);
    }

    for (const comment of unreactedComments) {
      await gh.addReaction(fullName, comment.id, "+1");
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

async function findUnreactedHumanComments(
  fullName: string,
  commentsAfterPlan: gh.IssueComment[],
  selfLogin: string,
): Promise<gh.IssueComment[]> {
  const unreacted: gh.IssueComment[] = [];
  for (const comment of commentsAfterPlan) {
    if (gh.isYetiComment(comment.body)) continue;
    if (comment.login.endsWith("[bot]")) continue;
    try {
      const reactions = await gh.getCommentReactions(fullName, comment.id);
      const hasReaction = reactions.some(
        (r) => r.user.login === selfLogin && r.content === "+1",
      );
      if (!hasReaction) {
        unreacted.push(comment);
      }
    } catch {
      unreacted.push(comment);
    }
  }
  return unreacted;
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

        // Skip issues with "Refined" label (being implemented)
        if (issue.labels.some((l) => l.name === LABELS.refined)) continue;

        // Check for follow-up comments on issues with an open PR
        const openPR = await gh.getOpenPRForIssue(repo.fullName, issue.number);
        if (openPR) {
          const comments = await gh.getIssueComments(repo.fullName, issue.number);
          const lastPlanIdx = comments.findLastIndex(
            (c) => c.body.includes(PLAN_HEADER) && gh.isYetiComment(c.body),
          );
          if (lastPlanIdx !== -1) {
            const commentsAfterPlan = comments.slice(lastPlanIdx + 1);
            const unreactedComments = await findUnreactedHumanComments(repo.fullName, commentsAfterPlan, selfLogin);
            if (unreactedComments.length > 0) {
              gh.populateQueueCache("needs-refinement", repo.fullName, { number: issue.number, title: issue.title, type: "issue", updatedAt: issue.updatedAt, priority: gh.hasPriorityLabel(issue.labels) });
              tasks.push(
                processFollowUp(repo, issue, openPR.number, unreactedComments).catch((err) =>
                  reportError("issue-refiner:process-follow-up", `${repo.fullName}#${issue.number}`, err),
                ),
              );
            }
          }
          continue;
        }

        // Triage-before-refinement: skip [yeti-error] issues without triage report
        if (extractFingerprint(issue.title) !== null) {
          const comments = await gh.getIssueComments(repo.fullName, issue.number);
          const hasReport = comments.some((c) => c.body.includes(YETI_ERROR_REPORT_HEADER));
          if (!hasReport) continue;
        }

        // Fetch comments to determine state
        const comments = await gh.getIssueComments(repo.fullName, issue.number);
        const lastPlanIdx = comments.findLastIndex(
          (c) => c.body.includes(PLAN_HEADER) && gh.isYetiComment(c.body),
        );

        if (lastPlanIdx === -1) {
          // No plan comment exists — require Needs Refinement label for new plans
          // (exempt ci-unrelated and yeti-error issues — machine-generated with well-defined workflows)
          if (!isCiUnrelatedIssue(issue) && extractFingerprint(issue.title) === null &&
              !issue.labels.some((l) => l.name === LABELS.needsRefinement)) {
            continue;
          }
          gh.populateQueueCache("needs-refinement", repo.fullName, { number: issue.number, title: issue.title, type: "issue", updatedAt: issue.updatedAt, priority: gh.hasPriorityLabel(issue.labels) });
          tasks.push(
            processIssue(repo, issue).catch((err) =>
              reportError("issue-refiner:process-issue", `${repo.fullName}#${issue.number}`, err),
            ),
          );
        } else if (issue.labels.some((l) => l.name === LABELS.needsRefinement)) {
          const planComment = comments[lastPlanIdx];
          const commentsAfterPlan = comments.slice(lastPlanIdx + 1);
          const unreactedComments = await findUnreactedHumanComments(repo.fullName, commentsAfterPlan, selfLogin);
          const review = findReviewOfPlanVersion(comments, planComment.id, planComment.updatedAt);

          gh.populateQueueCache("needs-refinement", repo.fullName, { number: issue.number, title: issue.title, type: "issue", updatedAt: issue.updatedAt, priority: gh.hasPriorityLabel(issue.labels) });

          if (unreactedComments.length > 0) {
            // Human feedback outranks the loop; absorb a pending review into the same revision.
            const feedback = review ? [review, ...unreactedComments] : unreactedComments;
            tasks.push(
              processRefinement(repo, issue, feedback).catch((err) =>
                reportError("issue-refiner:process-refinement", `${repo.fullName}#${issue.number}`, err),
              ),
            );
          } else if (review) {
            // Reviewer kicked the plan back: targeted revision, not a replan.
            tasks.push(
              processReviewRevision(repo, issue, planComment, review).catch((err) =>
                reportError("issue-refiner:process-review-revision", `${repo.fullName}#${issue.number}`, err),
              ),
            );
          } else {
            // Human re-added the label with no new input — deliberate "start over".
            tasks.push(
              processIssue(repo, issue).catch((err) =>
                reportError("issue-refiner:process-issue", `${repo.fullName}#${issue.number}`, err),
              ),
            );
          }
        } else {
          // Plan exists — check for unreacted human comments after the plan
          const commentsAfterPlan = comments.slice(lastPlanIdx + 1);
          const unreactedComments = await findUnreactedHumanComments(repo.fullName, commentsAfterPlan, selfLogin);

          if (unreactedComments.length > 0) {
            // Human feedback needs addressing
            gh.populateQueueCache("needs-refinement", repo.fullName, { number: issue.number, title: issue.title, type: "issue", updatedAt: issue.updatedAt, priority: gh.hasPriorityLabel(issue.labels) });
            await gh.removeLabel(repo.fullName, issue.number, LABELS.ready);
            tasks.push(
              processRefinement(repo, issue, unreactedComments).catch((err) =>
                reportError("issue-refiner:process-refinement", `${repo.fullName}#${issue.number}`, err),
              ),
            );
          } else {
            // All feedback addressed — waiting for "Refined" or more feedback
            gh.populateQueueCache("ready", repo.fullName, { number: issue.number, title: issue.title, type: "issue", updatedAt: issue.updatedAt, priority: gh.hasPriorityLabel(issue.labels) });
            if (isCiUnrelatedIssue(issue) && !issue.labels.some((l) => l.name === LABELS.refined)) {
              await gh.addLabel(repo.fullName, issue.number, LABELS.refined);
              log.info(`[issue-refiner] Auto-refined ci-unrelated issue ${repo.fullName}#${issue.number}`);
            }
          }
        }
      }
    } catch (err) {
      reportError("issue-refiner:list-issues", repo.fullName, err);
    }
  }

  await Promise.allSettled(tasks);
}
