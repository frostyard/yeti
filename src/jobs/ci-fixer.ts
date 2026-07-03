import { JOB_AI, repoAutonomy, type Repo } from "../config.js";
import { can } from "../capability.js";
import * as gh from "../github.js";
import { isRateLimited, RateLimitError } from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";
import { notify } from "../notify.js";
import { ShutdownError } from "../shutdown.js";
import { renderPolicy, type Autonomy } from "../policy.js";
import { enforceLearnings } from "../learnings.js";

type WorkItem =
  | { kind: "conflict"; repo: Repo; pr: gh.PR }
  | { kind: "rerun"; repo: Repo; pr: gh.PR; runId: string }
  | { kind: "unrelated"; repo: Repo; pr: gh.PR; fingerprint: string; reason: string; failLog: string; changedFiles: string[]; runUrl: string }
  | { kind: "fix"; repo: Repo; pr: gh.PR; failLog: string };

export function buildConflictPrompt(autonomy: Autonomy, fullName: string, pr: gh.PR, conflictedFiles: string[]): string {
  return renderPolicy("ci-fixer.conflict", autonomy, {
    FULL_NAME: fullName,
    PR_NUMBER: String(pr.number),
    PR_TITLE: pr.title,
    HEAD_REF: pr.headRefName,
    BASE_REF: pr.baseRefName,
    CONFLICTED_FILES: conflictedFiles.map((f) => `- ${f}`).join("\n"),
  });
}

async function resolveConflicts(repo: Repo, pr: gh.PR): Promise<boolean> {
  const fullName = repo.fullName;

  const state = await gh.getPRMergeableState(fullName, pr.number);
  if (state !== "CONFLICTING") return false;

  log.info(`[ci-fixer] Resolving merge conflicts for ${fullName}#${pr.number}`);

  const taskId = db.recordTaskStart("ci-fixer:merge-conflict", fullName, pr.number, null);
  let wtPath: string | undefined;

  try {
    wtPath = await claude.createWorktreeFromBranch(repo, pr.headRefName, "ci-fixer");
    db.updateTaskWorktree(taskId, wtPath, pr.headRefName);

    const { clean, conflictedFiles } = await claude.attemptMerge(wtPath, pr.baseRefName);

    if (clean) {
      // Merge was auto-resolved by git — just push
      await claude.pushBranch(wtPath, pr.headRefName, fullName);
      log.info(`[ci-fixer] Clean merge pushed for ${fullName}#${pr.number}`);
      notify({ jobName: "ci-fixer", message: `Resolved merge conflict for ${fullName}#${pr.number}`, url: gh.pullUrl(fullName, pr.number) });
      db.recordTaskComplete(taskId);
      return true;
    }

    // Conflicts need Claude to resolve
    const prompt = buildConflictPrompt(repoAutonomy(repo), fullName, pr, conflictedFiles);

    const aiOptions = JOB_AI["ci-fixer"];
    const output = await claude.resolveEnqueue(aiOptions)(() => claude.runAI(prompt, wtPath!, aiOptions), gh.hasPriorityLabel(pr.labels));
    await enforceLearnings(output, { jobName: "ci-fixer", repo: fullName, wtPath, baseBranch: pr.headRefName, mergeBase: pr.baseRefName, aiOptions });

    if (await claude.hasNewCommits(wtPath, pr.headRefName) && await claude.hasTreeDiff(wtPath, pr.headRefName)) {
      await claude.pushBranch(wtPath, pr.headRefName, fullName);
      try {
        const description = await claude.regeneratePRDescription(wtPath, pr.baseRefName, pr, aiOptions);
        await gh.updatePRBody(fullName, pr.number, description);
      } catch (descErr) {
        log.warn(`[ci-fixer] Failed to update PR description for ${fullName}#${pr.number}: ${descErr}`);
      }
      log.info(`[ci-fixer] Conflict resolution pushed for ${fullName}#${pr.number}`);
      notify({ jobName: "ci-fixer", message: `Resolved merge conflict for ${fullName}#${pr.number}`, url: gh.pullUrl(fullName, pr.number) });
    } else {
      log.warn(`[ci-fixer] No commits from conflict resolution for ${fullName}#${pr.number}`);
      await claude.abortMerge(wtPath);
    }

    db.recordTaskComplete(taskId);
    return true;
  } catch (err) {
    db.recordTaskFailed(taskId, String(err));
    if (wtPath) {
      try {
        await claude.abortMerge(wtPath);
      } catch {
        // Merge may not be in progress
      }
    }
    throw err;
  } finally {
    if (wtPath) {
      await claude.removeWorktree(repo, wtPath);
    }
  }
}

const CANCELLED_STATES = new Set(["CANCELLED", "STARTUP_FAILURE"]);

interface Classification {
  related: boolean;
  fingerprint: string;
  reason: string;
}

function normalizeFailingPath(path: string): string {
  return path
    .trim()
    .replace(/^["'`([{<]+/, "")
    .replace(/[)"'`>\]},.;:]+$/, "")
    .replace(/^\.\/+/, "")
    .replace(/^[ab]\//, "");
}

export function extractFailingPaths(failLog: string): string[] {
  const paths = new Set<string>();
  const addPath = (raw: string | undefined) => {
    if (!raw) return;
    const normalized = normalizeFailingPath(raw);
    if (!normalized || normalized.includes("://") || normalized.includes("node_modules/")) return;
    paths.add(normalized);
  };

  for (const match of failLog.matchAll(/^\s*(?:FAIL|❯|×)\s+(\S+)/gm)) {
    addPath(match[1]);
  }

  for (const match of failLog.matchAll(/([\w./-]+\.[\w]+):\d+(?::\d+)?/g)) {
    addPath(match[1]);
  }

  for (const match of failLog.matchAll(/(?:^|[\s"'(])([\w.-]+(?:\/[\w.-]+)*\.[\w]+)\b/gm)) {
    addPath(match[1]);
  }

  for (const match of failLog.matchAll(/(?:^|[\s"'([])(Dockerfile|Makefile|Procfile|Rakefile|Gemfile)\b/gm)) {
    addPath(match[1]);
  }

  return [...paths].sort();
}

function normalizeChangedFile(path: string): string {
  return path.trim().replace(/^\.\/+/, "").replace(/^[ab]\//, "");
}

export function hasFileOverlap(failingPaths: string[], changedFiles: string[]): boolean {
  if (failingPaths.length === 0 || changedFiles.length === 0) return false;

  const normalizedFailingPaths = failingPaths.map(normalizeFailingPath).filter(Boolean);
  const normalizedChangedFiles = changedFiles.map(normalizeChangedFile).filter(Boolean);

  return normalizedFailingPaths.some((failingPath) => normalizedChangedFiles.some((changedFile) => {
    if (failingPath === changedFile) return true;
    // Logs can include an absolute workspace prefix before a repo-relative
    // changed path. Do not match the reverse direction or root-level basenames.
    return changedFile.includes("/") && failingPath.endsWith(`/${changedFile}`);
  }));
}

export function deriveFingerprint(checkName: string, failingPath: string | undefined): string {
  const checkSlug = checkName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-") || "ci";
  const normalizedPath = failingPath ? normalizeFailingPath(failingPath) : "";
  return normalizedPath ? `${checkSlug}:${normalizedPath}` : checkSlug;
}

export function parseClassification(response: string): { related: boolean; reason: string } | null {
  const jsonMatch = response.trim().match(/^\{[\s\S]*\}$/) ?? response.match(/\{[\s\S]*?"related"[\s\S]*?\}/);
  if (!jsonMatch) return null;

  try {
    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!parsed || typeof parsed !== "object") return null;
    const classification = parsed as { related?: unknown; reason?: unknown };
    if (typeof classification.related !== "boolean") return null;
    return {
      related: classification.related,
      reason: typeof classification.reason === "string" ? classification.reason : String(classification.reason ?? ""),
    };
  } catch {
    return null;
  }
}

export function buildClassifyPrompt(autonomy: Autonomy, pr: gh.PR, failLog: string, changedFiles: string[]): string {
  return renderPolicy("ci-fixer.classify", autonomy, {
    PR_NUMBER: String(pr.number),
    PR_TITLE: pr.title,
    HEAD_REF: pr.headRefName,
    CHANGED_FILES: changedFiles.map((f) => `- ${f}`).join("\n"),
    FAIL_LOG: failLog,
  });
}

async function classifyCIFailure(
  repo: Repo,
  pr: gh.PR,
  failLog: string,
  changedFiles: string[],
  checkName: string,
): Promise<Classification> {
  const failingPaths = extractFailingPaths(failLog);
  if (hasFileOverlap(failingPaths, changedFiles)) {
    return { related: true, fingerprint: "", reason: "failure in a file the PR changed" };
  }

  const prompt = buildClassifyPrompt(repoAutonomy(repo), pr, failLog, changedFiles);

  try {
    const aiOptions = JOB_AI["ci-fixer"];
    const response = await claude.resolveEnqueue(aiOptions)(() => claude.runAI(prompt, process.cwd(), aiOptions), gh.hasPriorityLabel(pr.labels));
    const parsed = parseClassification(response);

    if (!parsed) {
      log.warn("[ci-fixer] Unparseable classification response; defaulting to related");
      // Conservative default: a malformed residual classification should lead
      // to an attempted fix, not silently ignore a potentially real PR breakage.
      return { related: true, fingerprint: "", reason: "unparseable classification response; defaulted to related" };
    }

    if (parsed.related) {
      return { related: true, fingerprint: "", reason: parsed.reason };
    }

    return {
      related: false,
      fingerprint: deriveFingerprint(checkName, failingPaths[0]),
      reason: parsed.reason,
    };
  } catch (err) {
    log.warn(`[ci-fixer] Classification failed: ${err}`);
    return { related: true, fingerprint: "", reason: "classification failed" };
  }
}

async function identifyPRWork(repo: Repo, pr: gh.PR): Promise<WorkItem | null> {
  const fullName = repo.fullName;

  const state = await gh.getPRMergeableState(fullName, pr.number);
  if (state === "CONFLICTING") {
    return { kind: "conflict", repo, pr };
  }

  const failedCheck = await gh.getFailingCheck(fullName, pr.number);
  if (!failedCheck) return null;

  if (CANCELLED_STATES.has(failedCheck.state)) {
    const match = failedCheck.link?.match(/\/actions\/runs\/(\d+)/);
    if (match) return { kind: "rerun", repo, pr, runId: match[1] };
    log.warn(`[ci-fixer] Cancelled check for ${fullName}#${pr.number} has no re-runnable link`);
    return null;
  }

  log.info(`[ci-fixer] Fixing CI for ${fullName}#${pr.number}`);
  const failLog = await gh.getFailedRunLog(fullName, pr.number);
  if (!failLog) {
    // No logs available — likely a transient runner issue. Re-run the workflow.
    const match = failedCheck.link?.match(/\/actions\/runs\/(\d+)/);
    if (match) {
      log.info(`[ci-fixer] No failure logs for ${fullName}#${pr.number}, re-running workflow`);
      return { kind: "rerun", repo, pr, runId: match[1] };
    }
    log.warn(`[ci-fixer] No failure logs and no re-runnable link for ${fullName}#${pr.number}`);
    return null;
  }

  if (isCIUnrelatedFixPR(pr)) {
    log.info(`[ci-fixer] ${fullName}#${pr.number} is a ci-unrelated fix PR — skipping classification, treating as related`);
    return { kind: "fix", repo, pr, failLog };
  }

  const changedFiles = await gh.getPRChangedFiles(fullName, pr.number);
  const classification = await classifyCIFailure(repo, pr, failLog, changedFiles, failedCheck.name);

  if (classification.related) {
    return { kind: "fix", repo, pr, failLog };
  }

  log.info(`[ci-fixer] Failure for ${fullName}#${pr.number} classified as unrelated: ${classification.reason}`);
  return { kind: "unrelated", repo, pr, fingerprint: classification.fingerprint, reason: classification.reason, failLog, changedFiles, runUrl: failedCheck.link };
}

export function buildFixPrompt(autonomy: Autonomy, fullName: string, pr: gh.PR, failLog: string): string {
  return renderPolicy("ci-fixer", autonomy, {
    FULL_NAME: fullName,
    PR_NUMBER: String(pr.number),
    PR_TITLE: pr.title,
    HEAD_REF: pr.headRefName,
    FAIL_LOG: failLog,
  });
}

async function fixCI(repo: Repo, pr: gh.PR, failLog: string): Promise<void> {
  const fullName = repo.fullName;
  const taskId = db.recordTaskStart("ci-fixer", fullName, pr.number, null);
  let wtPath: string | undefined;

  try {
    wtPath = await claude.createWorktreeFromBranch(repo, pr.headRefName, "ci-fixer");
    db.updateTaskWorktree(taskId, wtPath, pr.headRefName);
    const preSha = await claude.getHeadSha(wtPath);

    const prompt = buildFixPrompt(repoAutonomy(repo), fullName, pr, failLog);

    const aiOptions = JOB_AI["ci-fixer"];
    const output = await claude.resolveEnqueue(aiOptions)(() => claude.runAI(prompt, wtPath!, aiOptions), gh.hasPriorityLabel(pr.labels));
    await enforceLearnings(output, { jobName: "ci-fixer", repo: fullName, wtPath, baseBranch: pr.headRefName, aiOptions });

    if (await claude.hasNewCommits(wtPath, pr.headRefName) && await claude.hasTreeDiff(wtPath, pr.headRefName)) {
      await claude.pushBranch(wtPath, pr.headRefName, fullName);
      const newShas = await claude.getNewCommitShas(wtPath, preSha);
      db.recordTaskCommits(taskId, newShas);
      try {
        const description = await claude.regeneratePRDescription(wtPath, pr.baseRefName, pr, aiOptions);
        await gh.updatePRBody(fullName, pr.number, description);
      } catch (descErr) {
        log.warn(`[ci-fixer] Failed to update PR description for ${fullName}#${pr.number}: ${descErr}`);
      }
      log.info(`[ci-fixer] Pushed fix for ${fullName}#${pr.number}`);
      notify({ jobName: "ci-fixer", message: `Pushed fix for ${fullName}#${pr.number}`, url: gh.pullUrl(fullName, pr.number) });
    } else {
      log.warn(`[ci-fixer] No commits produced for ${fullName}#${pr.number}`);
    }

    db.recordTaskComplete(taskId);
  } catch (err) {
    db.recordTaskFailed(taskId, String(err));
    throw err;
  } finally {
    if (wtPath) await claude.removeWorktree(repo, wtPath);
  }
}

async function fileUnrelatedIssue(
  repoName: string,
  occurrences: Array<{ fingerprint: string; reason: string; failLog: string; pr: gh.PR; runUrl: string }>,
): Promise<void> {
  const title = `[ci-unrelated] CI failures unrelated to PR changes`;

  try {
    const results = await gh.searchIssues(repoName, title);
    const existing = results.find((r) => r.title === title);

    let issueNumber: number;
    if (existing) {
      issueNumber = existing.number;
    } else {
      const body = [
        `**Auto-created by Yeti ci-fixer**`,
        "",
        `This issue tracks CI failures that are unrelated to the PRs they occurred on (flakey tests, runner issues, pre-existing failures).`,
        `Each occurrence is logged below.`,
      ].join("\n");
      issueNumber = await gh.createIssue(repoName, title, body, []);
      log.info(`[ci-fixer] Created issue #${issueNumber} for unrelated CI failures`);
      notify({ jobName: "ci-fixer", message: `Created ci-unrelated issue ${repoName}#${issueNumber}`, url: gh.issueUrl(repoName, issueNumber) });
    }

    for (const occ of occurrences) {
      const abbreviatedLog = occ.failLog.slice(0, 2000);
      const comment = [
        `### ${occ.fingerprint} — ${new Date().toISOString()}`,
        "",
        `**Observed on:** PR #${occ.pr.number} (${occ.pr.title})`,
        `**Reason:** ${occ.reason}`,
        `**Failing run:** ${occ.runUrl}`,
        "",
        "```",
        abbreviatedLog,
        "```",
      ].join("\n");
      await gh.commentOnIssue(repoName, issueNumber, comment);
      log.info(`[ci-fixer] Updated issue #${issueNumber} for "${occ.fingerprint}"`);
    }
  } catch (err) {
    log.warn(`[ci-fixer] Failed to file unrelated issue: ${err}`);
    reportError("ci-fixer:file-unrelated-issue", repoName, err);
  }
}

export function buildRevertPrompt(autonomy: Autonomy, pr: gh.PR, changedFiles: string[], shas: string[]): string {
  return renderPolicy("ci-fixer.revert", autonomy, {
    PR_NUMBER: String(pr.number),
    PR_TITLE: pr.title,
    HEAD_REF: pr.headRefName,
    CHANGED_FILES: changedFiles.map((f) => `- ${f}`).join("\n"),
    SHAS: shas.map((sha) => `- ${sha}`).join("\n"),
  });
}

async function revertPreviousUnrelatedFixes(
  repo: Repo,
  pr: gh.PR,
  changedFiles: string[],
): Promise<void> {
  const fullName = repo.fullName;

  // Skip if Yeti has never run ci-fixer on this PR
  if (!db.hasPreviousCiFixerTasks(fullName, pr.number)) {
    return;
  }

  const taskId = db.recordTaskStart("ci-fixer:revert", fullName, pr.number, null);
  let wtPath: string | undefined;

  try {
    wtPath = await claude.createWorktreeFromBranch(repo, pr.headRefName, "ci-fixer-revert");
    db.updateTaskWorktree(taskId, wtPath, pr.headRefName);

    const recorded = db.getCiFixerFixCommitShas(fullName, pr.number);
    if (recorded.length === 0) {
      db.recordTaskComplete(taskId);
      return;
    }

    const recordedSet = new Set(recorded);
    const branchOrder = await claude.commitsOnBranch(wtPath, pr.baseRefName);
    const alreadyReverted = new Set(await claude.getRevertedShas(wtPath, pr.baseRefName));
    const toRevert = branchOrder.filter((sha) => recordedSet.has(sha) && !alreadyReverted.has(sha));

    if (toRevert.length === 0) {
      db.recordTaskComplete(taskId);
      return;
    }

    const startSha = await claude.getHeadSha(wtPath);
    let conflicted = false;
    for (const sha of toRevert) {
      const { clean } = await claude.revertCommit(wtPath, sha);
      if (!clean) {
        await claude.abortRevert(wtPath);
        conflicted = true;
        break;
      }
    }

    if (conflicted) {
      await claude.resetHard(wtPath, startSha);
      const prompt = buildRevertPrompt(repoAutonomy(repo), pr, changedFiles, toRevert);
      const aiOptions = JOB_AI["ci-fixer"];
      await claude.resolveEnqueue(aiOptions)(() => claude.runAI(prompt, wtPath!, aiOptions), gh.hasPriorityLabel(pr.labels));
    }

    if (await claude.hasNewCommits(wtPath, pr.headRefName) && await claude.hasTreeDiff(wtPath, pr.headRefName)) {
      await claude.pushBranch(wtPath, pr.headRefName, fullName);
      log.info(`[ci-fixer] Reverted unrelated fixes for ${fullName}#${pr.number}`);
    }

    db.recordTaskComplete(taskId);
  } catch (err) {
    db.recordTaskFailed(taskId, String(err));
    log.warn(`[ci-fixer] Revert of unrelated fixes failed for ${fullName}#${pr.number}: ${err}`);
  } finally {
    if (wtPath) {
      await claude.removeWorktree(repo, wtPath);
    }
  }
}

async function mergeBaseIfBehind(repo: Repo, pr: gh.PR): Promise<void> {
  const fullName = repo.fullName;
  const taskId = db.recordTaskStart("ci-fixer:merge-base", fullName, pr.number, null);
  let wtPath: string | undefined;

  try {
    wtPath = await claude.createWorktreeFromBranch(repo, pr.headRefName, "ci-fixer-merge-base");
    db.updateTaskWorktree(taskId, wtPath, pr.headRefName);

    const behindCount = (await claude.git(
      ["rev-list", "--count", `HEAD..origin/${pr.baseRefName}`],
      wtPath,
    )).trim();

    if (behindCount === "0") {
      log.info(`[ci-fixer] Branch for ${fullName}#${pr.number} is already up-to-date with ${pr.baseRefName}`);
      db.recordTaskComplete(taskId);
      return;
    }

    log.info(`[ci-fixer] Branch for ${fullName}#${pr.number} is ${behindCount} commits behind ${pr.baseRefName}, merging`);

    const { clean } = await claude.attemptMerge(wtPath, pr.baseRefName);

    if (clean) {
      await claude.pushBranch(wtPath, pr.headRefName, fullName);
      log.info(`[ci-fixer] Merged ${pr.baseRefName} into ${pr.headRefName} for ${fullName}#${pr.number}`);
    } else {
      await claude.abortMerge(wtPath);
      log.info(`[ci-fixer] Merge of ${pr.baseRefName} into ${pr.headRefName} has conflicts for ${fullName}#${pr.number}, skipping`);
    }

    db.recordTaskComplete(taskId);
  } catch (err) {
    db.recordTaskFailed(taskId, String(err));
    log.warn(`[ci-fixer] Merge-base failed for ${fullName}#${pr.number}: ${err}`);
  } finally {
    if (wtPath) {
      await claude.removeWorktree(repo, wtPath);
    }
  }
}

const CI_FIXER_ERROR_HEADING = "### CI Fixer Error";

function isCIUnrelatedFixPR(pr: gh.PR): boolean {
  return pr.title.includes("[ci-unrelated]");
}

async function postErrorOnPR(repoName: string, pr: gh.PR, err: unknown): Promise<void> {
  try {
    const errMsg = err instanceof Error ? err.stack ?? err.message : String(err);
    const truncated = errMsg.slice(0, 3000);
    const body = [
      CI_FIXER_ERROR_HEADING,
      "",
      "CI fixer encountered an error while processing this PR. It will retry on the next cycle.",
      "",
      "```",
      truncated,
      "```",
    ].join("\n");

    const comments = await gh.getIssueComments(repoName, pr.number);
    const existing = comments.find(
      (c) => gh.isYetiComment(c.body) && c.body.includes(CI_FIXER_ERROR_HEADING),
    );

    if (existing) {
      await gh.editIssueComment(repoName, existing.id, body);
    } else {
      await gh.commentOnIssue(repoName, pr.number, body);
    }
  } catch (commentErr) {
    log.warn(`[ci-fixer] Failed to post error comment on ${repoName}#${pr.number}: ${commentErr}`);
  }
}

export async function run(repos: Repo[]): Promise<void> {
  // Phase 1: Identify all work
  const identifyTasks: Promise<WorkItem | null>[] = [];

  for (const repo of repos) {
    if (isRateLimited()) break;
    if (!can(repo, "push")) {
      log.info(`[ci-fixer] skip ${repo.fullName} — tier below 'push' requirement`);
      continue;
    }
    try {
      const prs = await gh.listPRs(repo.fullName);
      for (const pr of prs) {
        if (gh.isItemSkipped(repo.fullName, pr.number)) continue;
        identifyTasks.push(
          identifyPRWork(repo, pr).catch((err) => {
            if (err instanceof ShutdownError) {
              log.info(`[ci-fixer] Shutdown during ${repo.fullName}#${pr.number}`);
            } else if (err instanceof RateLimitError) {
              log.warn(`[ci-fixer] Rate limited during ${repo.fullName}#${pr.number}`);
            } else {
              reportError("ci-fixer:identify", `${repo.fullName}#${pr.number}`, err);
            }
            return null;
          }),
        );
      }
    } catch (err) {
      reportError("ci-fixer:list-prs", repo.fullName, err);
    }
  }

  const results = await Promise.allSettled(identifyTasks);
  const items = results
    .filter((r): r is PromiseFulfilledResult<WorkItem | null> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((item): item is WorkItem => item !== null);

  // Phase 2a: Process unrelated failures (grouped by repo — structural dedup)
  const unrelatedByRepo = new Map<string, { repo: Repo; items: Array<Extract<WorkItem, { kind: "unrelated" }>> }>();
  for (const item of items) {
    if (item.kind !== "unrelated") continue;
    let group = unrelatedByRepo.get(item.repo.fullName);
    if (!group) {
      group = { repo: item.repo, items: [] };
      unrelatedByRepo.set(item.repo.fullName, group);
    }
    group.items.push(item);
  }

  for (const [repoName, group] of unrelatedByRepo) {
    await fileUnrelatedIssue(repoName, group.items);
    for (const item of group.items) {
      await revertPreviousUnrelatedFixes(item.repo, item.pr, item.changedFiles);
      await mergeBaseIfBehind(item.repo, item.pr);
    }
  }

  // Phase 2b: Process remaining items concurrently
  const processTasks: Promise<void>[] = [];
  for (const item of items) {
    if (item.kind === "conflict") {
      processTasks.push(
        resolveConflicts(item.repo, item.pr).then(() => {}).catch((err) => {
          if (err instanceof ShutdownError) log.info(`[ci-fixer] Shutdown during ${item.repo.fullName}#${item.pr.number}`);
          else if (err instanceof RateLimitError) log.warn(`[ci-fixer] Rate limited during ${item.repo.fullName}#${item.pr.number}`);
          else reportError("ci-fixer:process-pr", `${item.repo.fullName}#${item.pr.number}`, err);
        }),
      );
    } else if (item.kind === "rerun") {
      processTasks.push(
        (async () => {
          log.info(`[ci-fixer] Re-running cancelled check for ${item.repo.fullName}#${item.pr.number}`);
          await gh.rerunWorkflow(item.repo.fullName, item.runId);
        })().catch((err) => {
          if (err instanceof Error && /already running/i.test(err.message)) {
            log.info(`[ci-fixer] Workflow ${item.runId} for ${item.repo.fullName}#${item.pr.number} is already running, skipping rerun`);
            return;
          }
          reportError("ci-fixer:rerun", `${item.repo.fullName}#${item.pr.number}`, err);
        }),
      );
    } else if (item.kind === "fix") {
      processTasks.push(
        fixCI(item.repo, item.pr, item.failLog).catch((err) => {
          if (err instanceof ShutdownError) log.info(`[ci-fixer] Shutdown during ${item.repo.fullName}#${item.pr.number}`);
          else if (err instanceof RateLimitError) log.warn(`[ci-fixer] Rate limited during ${item.repo.fullName}#${item.pr.number}`);
          else if (isCIUnrelatedFixPR(item.pr)) {
            log.error(`[ci-fixer] Error on ci-unrelated fix PR ${item.repo.fullName}#${item.pr.number}: ${err}`);
            return postErrorOnPR(item.repo.fullName, item.pr, err);
          } else reportError("ci-fixer:process-pr", `${item.repo.fullName}#${item.pr.number}`, err);
        }),
      );
    }
  }

  await Promise.allSettled(processTasks);
}
