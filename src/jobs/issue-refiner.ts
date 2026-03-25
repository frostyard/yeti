import { LABELS, ENABLED_JOBS, JOB_AI, type Repo } from "../config.js";
import * as gh from "../github.js";
import { isRateLimited } from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";
import { notify } from "../notify.js";
import { processTextForImages } from "../images.js";
import { extractFingerprint, REPORT_HEADER as YETI_ERROR_REPORT_HEADER } from "./triage-yeti-errors.js";
import { PLAN_HEADER } from "../plan-parser.js";

function isCiUnrelatedIssue(issue: gh.Issue): boolean {
  return issue.title.startsWith("[ci-unrelated]");
}

const MULTI_PR_INSTRUCTIONS = [
  `Prefer a single PR. Do not split work into multiple PRs just because the change`,
  `touches several files or is moderately large. A single PR is easier to review,`,
  `test, and deploy. Only use multiple PRs when the work is genuinely too large or`,
  `risky to ship atomically — for example, a schema migration that must be deployed`,
  `before the code that depends on it, or a change that exceeds ~800 lines across`,
  `more than 15 files.`,
  ``,
  `If you do need multiple PRs, use this exact format:`,
  ``,
  `### PR 1: [short title]`,
  `[description, files, changes for this PR]`,
  ``,
  `### PR 2: [short title]`,
  `[description, files, changes for this PR]`,
  ``,
  `Each PR must be independently deployable and functional.`,
  `If the change is small enough for a single PR, you do not need to use this format.`,
].join("\n");

function buildRefinementPrompt(
  fullName: string,
  issue: gh.Issue,
  existingPlan: string,
  feedback: gh.IssueComment[],
): string {
  return [
    `You are analyzing a GitHub issue for the repository ${fullName}.`,
    `Issue #${issue.number}: ${issue.title}`,
    ``,
    issue.body || "(No description provided)",
    ``,
    `A previous implementation plan was produced:`,
    ``,
    existingPlan,
    ``,
    ...(feedback.length > 0
      ? [
          `The following feedback was provided on the plan:`,
          ``,
          ...feedback.flatMap((f) => {
            const label = gh.isYetiComment(f.body)
              ? `Comment by @${f.login} (automated by Yeti):`
              : `Comment by @${f.login}:`;
            return [`---`, label, gh.stripYetiMarker(f.body), ``];
          }),
        ]
      : [`No specific feedback comments were provided. Re-evaluate the plan for:`,
          `- Missing files or changes that should be included`,
          `- Edge cases or risks not yet addressed`,
          `- Whether the implementation order is correct`,
          `- Whether the testing approach is sufficient`,
          ``]),
    ``,
    `If \`yeti/OVERVIEW.md\` exists in the repository, read it first (and any linked documents that seem relevant to the issue) for context about the codebase architecture and patterns.`,
    ``,
    `Address each piece of feedback individually. Do not silently drop or ignore`,
    `any feedback item — if you disagree with a suggestion, explain why.`,
    ``,
    `Preserve sections of the plan that are not affected by the feedback. Only`,
    `rewrite sections that need to change. This avoids introducing regressions`,
    `in already-reviewed parts of the plan.`,
    ``,
    `Stay within the scope of the original issue. If feedback suggests expanding`,
    `beyond what the issue asks for, note the suggestion in a separate`,
    `"### Out of Scope" section rather than incorporating it into the plan.`,
    ``,
    `If any feedback is ambiguous or contradictory, DO NOT guess. Instead,`,
    `output a "### Clarifying Questions" section listing specific questions`,
    `that need answers before those feedback items can be addressed. Instruct`,
    `the user to respond as a comment on the GitHub issue so the next`,
    `refinement cycle can incorporate their answers.`,
    ``,
    `Please produce an updated implementation plan that addresses the feedback.`,
    `Include:`,
    `- Which files need to be changed`,
    `- What the changes should be`,
    `- Any potential risks or edge cases`,
    `- A suggested order of implementation`,
    `- How to verify the changes work (testing approach)`,
    ``,
    MULTI_PR_INSTRUCTIONS,
    ``,
    `If there were any surprises or deviations while addressing the feedback, explain them briefly in a separate section at the end of your response, prefixed with \`### Note\``,
    ``,
    `Do NOT make any code changes. Only produce the plan as text output.`,
  ].join("\n");
}

function buildFollowUpPrompt(
  fullName: string,
  issue: gh.Issue,
  existingPlan: string,
  openPRNumber: number,
  followUpComments: gh.IssueComment[],
): string {
  return [
    `You are responding to follow-up questions on a GitHub issue for the repository ${fullName}.`,
    `Issue #${issue.number}: ${issue.title}`,
    ``,
    issue.body || "(No description provided)",
    ``,
    `An implementation plan was already produced and a PR #${openPRNumber} is open to implement it.`,
    ``,
    `Here is the existing plan:`,
    ``,
    existingPlan,
    ``,
    `The following follow-up comments were posted after the plan:`,
    ``,
    ...followUpComments.flatMap((f) => {
      const label = gh.isYetiComment(f.body)
        ? `Comment by @${f.login} (automated by Yeti):`
        : `Comment by @${f.login}:`;
      return [`---`, label, gh.stripYetiMarker(f.body), ``];
    }),
    ``,
    `If \`yeti/OVERVIEW.md\` exists in the repository, read it first (and any linked documents that seem relevant) for context about the codebase architecture and patterns.`,
    ``,
    `Please respond to the follow-up comments above. Answer questions, provide clarifications, or address concerns.`,
    `Do NOT produce a new implementation plan — the implementation is already in progress via PR #${openPRNumber}.`,
    `If the comments suggest changes that should be made to the PR, mention that in your response.`,
    ``,
    `Do NOT make any code changes. Only produce your response as text output.`,
  ].join("\n");
}

function buildNewPlanPrompt(fullName: string, issue: gh.Issue, comments: gh.IssueComment[]): string {
  return [
    `You are a senior software engineer producing an implementation plan for a GitHub issue.`,
    `Repository: ${fullName}`,
    `Issue #${issue.number}: ${issue.title}`,
    ``,
    issue.body || "(No description provided)",
    ``,
    ...comments.flatMap((c) => {
      const label = gh.isYetiComment(c.body)
        ? `Comment by @${c.login} (automated by Yeti):`
        : `Comment by @${c.login}:`;
      return [`---`, label, gh.stripYetiMarker(c.body), ``];
    }),
    `If \`yeti/OVERVIEW.md\` exists in the repository, read it first (and any linked documents that seem relevant to the issue) for context about the codebase architecture and patterns.`,
    ``,
    `Before reading any source files, read the issue carefully and identify which parts of the codebase are likely affected. Then read the relevant source files to ground your plan in the actual code — do not plan changes to files you have not read.`,
    ``,
    `## Step 1: Evaluate whether the issue is plannable`,
    ``,
    `Before producing a plan, assess whether the issue provides enough detail:`,
    `- Is the desired behavior clearly specified?`,
    `- Are acceptance criteria stated or inferable?`,
    `- Are there ambiguous terms or multiple valid interpretations?`,
    `- Is the scope well-defined?`,
    ``,
    `If the issue is underspecified, DO NOT guess or fill in gaps with assumptions. Instead, output a section titled \`### Clarifying Questions\` listing specific questions that would need answers before a reliable plan can be written. Be concrete — reference the parts of the issue that are ambiguous and suggest options where possible (e.g., "Should X behave like A or B?").`,
    ``,
    `After listing your clarifying questions, instruct the user to respond to them as a comment on the GitHub issue so that the next refinement cycle can incorporate their answers and produce a complete plan.`,
    ``,
    `Only produce the implementation plan for aspects that are sufficiently clear. If nothing is clear enough to plan, output only the clarifying questions and the instruction to respond.`,
    ``,
    `## Steps 2–4 apply only to aspects that are sufficiently clear to plan.`,
    `## If nothing is plannable, skip directly to output and produce only the`,
    `## clarifying questions from Step 1.`,
    ``,
    `## Step 2: Draft an initial implementation plan`,
    ``,
    `For each file that needs to change, specify:`,
    `- The file path`,
    `- What specifically needs to be added, modified, or removed`,
    `- Why the change is needed (tie it back to the issue requirement)`,
    ``,
    `Also include:`,
    `- **Implementation order**: Which changes should be made first and why (e.g., types before consumers, schema before queries)`,
    `- **Dependencies**: Note if any change depends on another being completed first`,
    `- **Risks and edge cases**: What could go wrong? What inputs or states might break? What existing behavior might regress?`,
    `- **Testing approach**: How should the changes be verified? Specify whether unit tests, integration tests, or manual verification is appropriate for each change. Name the test files that should be created or modified.`,
    ``,
    `Do NOT include changes that are not required by the issue. Do not refactor surrounding code, add nice-to-have improvements, or expand scope beyond what is asked.`,
    ``,
    `If the issue could be interpreted broadly, choose the narrowest reasonable interpretation and note your assumption explicitly so the reviewer can correct it.`,
    ``,
    `## Step 3: Self-critique and revise (repeat twice)`,
    ``,
    `After drafting your plan, perform two rounds of structured self-critique`,
    `before producing your final output. For each round, evaluate your current`,
    `plan against these four questions:`,
    ``,
    `1. **Unverified assumptions**: What have I assumed about the codebase that`,
    `I have not confirmed by reading the actual source files? Go back and read`,
    `any files I referenced but did not actually open. Check that the functions,`,
    `types, patterns, and file paths I mentioned actually exist as I described them.`,
    ``,
    `2. **Scope discipline**: Am I proposing changes beyond what the issue`,
    `requires? Remove anything that is not directly necessary to satisfy the`,
    `issue's requirements. If I added "while we're at it" improvements, cut them.`,
    ``,
    `3. **Ordering and dependencies**: If a developer followed my plan step-by-step`,
    `in the order I listed, would each step succeed? Or would they hit a compile`,
    `error because a dependency has not been built yet? Reorder if needed.`,
    ``,
    `4. **Risk honesty**: What failure modes or edge cases did I omit because they`,
    `would complicate the plan? Add them to the risks section rather than`,
    `pretending they do not exist.`,
    ``,
    `After each critique round, revise the plan to address every weakness you`,
    `found. If a critique round reveals no issues, state that explicitly rather`,
    `than inventing problems.`,
    ``,
    `## Step 4: Produce the final plan`,
    ``,
    `Output ONLY your final revised plan. Do not include your intermediate`,
    `drafts, critiques, or revision notes in your output. The output should`,
    `read as a single clean implementation plan. If the issue was not plannable`,
    `(Step 1), output only the clarifying questions — do not invent a plan.`,
    ``,
    MULTI_PR_INSTRUCTIONS,
    ``,
    `Do NOT make any code changes. Only produce the plan as text output.`,
  ].join("\n");
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
    const prompt = buildNewPlanPrompt(fullName, issue, comments) + imageContext;

    const planOutput = await claude.resolveEnqueue(aiOptions)(() => claude.runAI(prompt, wtPath!, aiOptions), gh.hasPriorityLabel(issue.labels));

    if (planOutput.trim()) {
      await gh.commentOnIssue(fullName, issue.number, `${PLAN_HEADER}\n\n${planOutput}`);
      log.info(`[issue-refiner] Posted plan for ${fullName}#${issue.number}`);
      notify({ jobName: "issue-refiner", message: `Plan produced for ${fullName}#${issue.number}`, url: gh.issueUrl(fullName, issue.number) });
    } else {
      log.warn(`[issue-refiner] Empty plan output for ${fullName}#${issue.number}`);
    }

    if (ENABLED_JOBS.includes("plan-reviewer")) {
      await gh.addLabel(fullName, issue.number, LABELS.needsPlanReview);
    } else {
      await gh.addLabel(fullName, issue.number, LABELS.ready);
    }
    await gh.removeLabel(fullName, issue.number, LABELS.needsRefinement);

    if (isCiUnrelatedIssue(issue)) {
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

    if (lastPlanIdx === -1) {
      log.warn(`[issue-refiner] No plan comment found for ${fullName}#${issue.number}, posting fresh plan`);
      const imageContext = await processTextForImages([issue.body, ...comments.map((c) => c.body)], wtPath);
      const prompt = buildNewPlanPrompt(fullName, issue, comments) + imageContext;
      const planOutput = await claude.resolveEnqueue(aiOptions)(() => claude.runAI(prompt, wtPath!, aiOptions), gh.hasPriorityLabel(issue.labels));

      if (planOutput.trim()) {
        await gh.commentOnIssue(fullName, issue.number, `${PLAN_HEADER}\n\n${planOutput}`);
        log.info(`[issue-refiner] Posted fresh plan for ${fullName}#${issue.number}`);
        notify({ jobName: "issue-refiner", message: `Plan produced for ${fullName}#${issue.number}`, url: gh.issueUrl(fullName, issue.number) });
      } else {
        log.warn(`[issue-refiner] Empty plan output for ${fullName}#${issue.number}`);
      }
    } else {
      const planComment = comments[lastPlanIdx];
      const feedback = unreactedComments;

      const imageContext = await processTextForImages([issue.body], wtPath);
      const prompt = buildRefinementPrompt(fullName, issue, planComment.body, feedback) + imageContext;
      const planOutput = await claude.resolveEnqueue(aiOptions)(() => claude.runAI(prompt, wtPath!, aiOptions), gh.hasPriorityLabel(issue.labels));

      if (planOutput.trim()) {
        // Check for "### Note" section to post separately
        const noteMatch = planOutput.match(/### Note\s*\n([\s\S]*)$/);
        const planBody = noteMatch
          ? planOutput.slice(0, noteMatch.index).trim()
          : planOutput;

        await gh.editIssueComment(fullName, planComment.id, `${PLAN_HEADER}\n\n${planBody}`);
        log.info(`[issue-refiner] Updated plan comment for ${fullName}#${issue.number}`);
        notify({ jobName: "issue-refiner", message: `Plan updated for ${fullName}#${issue.number}`, url: gh.issueUrl(fullName, issue.number) });

        if (noteMatch) {
          await gh.commentOnIssue(fullName, issue.number, `### Note\n${noteMatch[1].trim()}`);
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

    if (ENABLED_JOBS.includes("plan-reviewer")) {
      await gh.addLabel(fullName, issue.number, LABELS.needsPlanReview);
    } else {
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
    const prompt = buildFollowUpPrompt(fullName, issue, planComment.body, openPRNumber, unreactedComments) + imageContext;

    const response = await claude.resolveEnqueue(aiOptions)(() => claude.runAI(prompt, wtPath!, aiOptions), gh.hasPriorityLabel(issue.labels));

    if (response.trim()) {
      await gh.commentOnIssue(fullName, issue.number, response);
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
          // Plan exists but Needs Refinement label was re-added — produce a fresh plan
          gh.populateQueueCache("needs-refinement", repo.fullName, { number: issue.number, title: issue.title, type: "issue", updatedAt: issue.updatedAt, priority: gh.hasPriorityLabel(issue.labels) });
          tasks.push(
            processIssue(repo, issue).catch((err) =>
              reportError("issue-refiner:process-issue", `${repo.fullName}#${issue.number}`, err),
            ),
          );
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
