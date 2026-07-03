import { SELF_REPO, JOB_AI, repoAutonomy, type Repo } from "../config.js";
import { can } from "../capability.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";
import { notify } from "../notify.js";
import { renderPolicy } from "../policy.js";

/** Render pending learnings as the ${LEARNINGS} policy block, one [id] bullet each. */
export function formatLearnings(rows: db.LearningRow[]): string {
  return rows
    .map((l) => `- [${l.id}] (reported by ${l.job_name} while working on ${l.repo}, ${l.created_at}) ${l.summary}`)
    .join("\n");
}

/** Parse `DISMISSED: <id>: <reason>` lines from the agent's output. */
export function parseDismissals(output: string): Array<{ id: number; reason: string }> {
  const out: Array<{ id: number; reason: string }> = [];
  for (const m of output.matchAll(/^DISMISSED:\s*(\d+)\s*:\s*(.+)$/gim)) {
    out.push({ id: parseInt(m[1], 10), reason: m[2].trim() });
  }
  return out;
}

export function buildPRBody(
  consolidated: db.LearningRow[],
  dismissals: Array<{ id: number; reason: string }>,
): string {
  const lines = [
    `Consolidates environment learnings reported by agents during work sessions into the durable policy/docs files.`,
    ``,
    `## Learnings folded in`,
    ...consolidated.map((l) => `- ${l.summary} _(via ${l.job_name} on ${l.repo})_`),
  ];
  if (dismissals.length > 0) {
    lines.push(``, `## Dismissed`, ...dismissals.map((d) => `- [${d.id}] ${d.reason}`));
  }
  lines.push(``, `_Opened automatically by the learning-consolidator job. Merging deploys these learnings into every future agent prompt._`);
  return lines.join("\n");
}

export async function run(repos: Repo[]): Promise<void> {
  const selfRepo = repos.find((r) => r.fullName === SELF_REPO);
  if (!selfRepo) return;
  if (!can(selfRepo, "createPR")) {
    log.info(`[learning-consolidator] skip — tier below 'createPR' requirement`);
    return;
  }

  const pending = db.getPendingLearnings("yeti");
  if (pending.length === 0) return;

  try {
    // Fresh list bypasses the 60s TTL cache — avoids racing a just-created PR.
    const openPRs = await gh.listPRs(SELF_REPO, { fresh: true });
    if (openPRs.some((pr) => pr.headRefName.startsWith("yeti/learnings-"))) {
      log.info(`[learning-consolidator] Skipping — open learnings PR already exists`);
      return;
    }
  } catch (err) {
    reportError("learning-consolidator:list-prs", SELF_REPO, err);
    return;
  }

  log.info(`[learning-consolidator] Consolidating ${pending.length} pending learning(s)`);
  const branchName = `yeti/learnings-${claude.datestamp()}-${claude.randomSuffix()}`;
  const taskId = db.recordTaskStart("learning-consolidator", SELF_REPO, 0, null);
  let wtPath: string | undefined;
  let orphanBranch = false;

  try {
    wtPath = await claude.createWorktree(selfRepo, branchName, "learning-consolidator");
    db.updateTaskWorktree(taskId, wtPath, branchName);

    const prompt = renderPolicy("learning-consolidator", repoAutonomy(selfRepo), {
      LEARNINGS: formatLearnings(pending),
    });
    const aiOptions = JOB_AI["learning-consolidator"];
    const output = await claude.resolveEnqueue(aiOptions)(() => claude.runAI(prompt, wtPath!, aiOptions));

    const pendingIds = new Set(pending.map((l) => l.id));
    const dismissals = parseDismissals(output).filter((d) => pendingIds.has(d.id));
    for (const d of dismissals) {
      db.dismissLearning(d.id, d.reason);
      log.info(`[learning-consolidator] Dismissed learning ${d.id}: ${d.reason}`);
    }

    const dismissedIds = new Set(dismissals.map((d) => d.id));
    const consolidated = pending.filter((l) => !dismissedIds.has(l.id));

    if (
      consolidated.length > 0 &&
      (await claude.hasNewCommits(wtPath, selfRepo.defaultBranch)) &&
      (await claude.hasTreeDiff(wtPath, selfRepo.defaultBranch))
    ) {
      await claude.pushBranch(wtPath, branchName, SELF_REPO);
      orphanBranch = true;
      const prNumber = await gh.createPR(
        SELF_REPO,
        branchName,
        `chore(learnings): consolidate ${consolidated.length} environment learning(s)`,
        buildPRBody(consolidated, dismissals),
      );
      orphanBranch = false;
      db.markLearningsConsolidated(consolidated.map((l) => l.id), prNumber);
      log.info(`[learning-consolidator] Created PR #${prNumber} consolidating ${consolidated.length} learning(s)`);
      notify({
        jobName: "learning-consolidator",
        message: `Created PR #${prNumber} consolidating ${consolidated.length} learning(s)`,
        url: gh.pullUrl(SELF_REPO, prNumber),
      });
    } else if (consolidated.length > 0) {
      log.warn(`[learning-consolidator] ${consolidated.length} learning(s) not dismissed but no changes produced — leaving pending`);
    }

    db.recordTaskComplete(taskId);
  } catch (err) {
    if (orphanBranch && wtPath) {
      try {
        await claude.deleteRemoteBranch(wtPath, branchName, SELF_REPO);
        log.info(`[learning-consolidator] Deleted orphaned remote branch ${branchName} after PR creation failed`);
      } catch (delErr) {
        log.warn(`[learning-consolidator] Failed to delete orphaned remote branch ${branchName}: ${String(delErr)}`);
      }
    }
    db.recordTaskFailed(taskId, String(err));
    reportError("learning-consolidator:run", SELF_REPO, err);
  } finally {
    if (wtPath) {
      await claude.removeWorktree(selfRepo, wtPath);
    }
  }
}
