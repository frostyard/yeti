import { JOB_AI, repoAutonomy, type Repo } from "../config.js";
import { renderPolicy, type Autonomy } from "../policy.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";
import { notify } from "../notify.js";
import { can } from "../capability.js";

const MAX_IMPROVEMENTS_PER_RUN = 10;

export function buildAnalysisPrompt(
  autonomy: Autonomy,
  fullName: string,
  openIssueTitles: string[],
  openPRTitles: string[],
): string {
  const issueList =
    openIssueTitles.length > 0
      ? openIssueTitles.map((t) => `  - ${t}`).join("\n")
      : "  (none)";

  const prList =
    openPRTitles.length > 0
      ? openPRTitles.map((t) => `  - ${t}`).join("\n")
      : "  (none)";

  return renderPolicy("improvement-identifier", autonomy, {
    REPO: fullName,
    ISSUE_LIST: issueList,
    PR_LIST: prList,
  });
}

export function buildImplementationPrompt(autonomy: Autonomy, fullName: string, improvement: Improvement): string {
  return renderPolicy("improvement-identifier.implement", autonomy, {
    REPO: fullName,
    TITLE: improvement.title,
    BODY: improvement.body,
  });
}

interface Improvement {
  title: string;
  body: string;
}

export function parseImprovements(output: string): Improvement[] {
  // Try extracting from a JSON code fence first
  const fenceMatch = output.match(/```json\s*([\s\S]*?)```/);
  const jsonStr = fenceMatch ? fenceMatch[1].trim() : null;

  // Fall back to finding raw JSON object
  const rawMatch = jsonStr ?? (output.match(/\{[\s\S]*"improvements"[\s\S]*\}/)?.[0] ?? null);

  if (!rawMatch) {
    log.warn("[improvement-identifier] Could not find JSON in Claude output");
    return [];
  }

  try {
    const parsed = JSON.parse(rawMatch) as { improvements?: unknown[] };
    if (!Array.isArray(parsed.improvements)) return [];

    return parsed.improvements.filter(
      (item): item is Improvement =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Improvement).title === "string" &&
        typeof (item as Improvement).body === "string",
    );
  } catch (err) {
    log.warn(`[improvement-identifier] Failed to parse JSON: ${err}`);
    return [];
  }
}

const FOOTER = "\n\n---\n*Automated improvement by yeti improvement-identifier*";

async function processRepo(repo: Repo): Promise<void> {
  if (!can(repo, "createPR")) {
    log.info(`[improvement-identifier] skip ${repo.fullName} — tier below 'createPR' requirement`);
    return;
  }

  const fullName = repo.fullName;

  // Fetch open issue titles and PR titles for dedup context
  const openIssues = await gh.listOpenIssues(fullName);
  const openIssueTitles = openIssues.map((i) => i.title);
  const openPRs = await gh.listPRs(fullName);

  // Skip if improvement PRs are already open
  if (openPRs.some((pr) => pr.headRefName.startsWith("yeti/improve-"))) {
    log.info(`[improvement-identifier] Skipping ${fullName} — open improvement PR(s) exist`);
    return;
  }

  const openPRTitles = openPRs.map((p) => p.title);

  // Phase 1: Analysis — identify improvements via Claude
  const analysisBranch = `yeti/improve-${claude.randomSuffix()}`;
  const analysisTaskId = db.recordTaskStart("improvement-identifier", fullName, 0, null);
  let analysisWt: string | undefined;
  let improvements: Improvement[];

  try {
    analysisWt = await claude.createWorktree(repo, analysisBranch, "improvement-identifier");
    db.updateTaskWorktree(analysisTaskId, analysisWt, analysisBranch);

    log.info(`[improvement-identifier] Analyzing ${fullName}`);
    const prompt = buildAnalysisPrompt(repoAutonomy(repo), fullName, openIssueTitles, openPRTitles);
    const aiOptions = JOB_AI["improvement-identifier"];
    const output = await claude.resolveEnqueue(aiOptions)(() => claude.runAI(prompt, analysisWt!, aiOptions));

    improvements = parseImprovements(output);
    db.recordTaskComplete(analysisTaskId);
  } catch (err) {
    db.recordTaskFailed(analysisTaskId, String(err));
    throw err;
  } finally {
    if (analysisWt) {
      await claude.removeWorktree(repo, analysisWt);
    }
  }

  if (improvements.length === 0) {
    log.info(`[improvement-identifier] No improvements identified for ${fullName}`);
    return;
  }

  // Phase 2: Implementation — implement each improvement as a PR (concurrently)
  const capped = improvements.slice(0, MAX_IMPROVEMENTS_PER_RUN);
  if (improvements.length > MAX_IMPROVEMENTS_PER_RUN) {
    log.info(`[improvement-identifier] Capping at ${MAX_IMPROVEMENTS_PER_RUN} improvements for ${fullName} (${improvements.length} identified)`);
  }

  const tasks = capped.map(async (improvement) => {
    // Dedup check against both issues and PRs
    const existingIssues = await gh.searchIssues(fullName, improvement.title);
    const existingPRs = await gh.searchPRs(fullName, improvement.title);
    if (existingIssues.length > 0 || existingPRs.length > 0) {
      log.info(
        `[improvement-identifier] Skipping "${improvement.title}" — similar issue or PR already exists`,
      );
      return;
    }

    const implBranch = `yeti/improve-${claude.randomSuffix()}`;
    const implTaskId = db.recordTaskStart("improvement-identifier", fullName, 0, null);
    let implWt: string | undefined;

    try {
      implWt = await claude.createWorktree(repo, implBranch, "improvement-identifier");
      db.updateTaskWorktree(implTaskId, implWt, implBranch);

      const implPrompt = buildImplementationPrompt(repoAutonomy(repo), fullName, improvement);
      const aiOptions = JOB_AI["improvement-identifier"];
      await claude.resolveEnqueue(aiOptions)(() => claude.runAI(implPrompt, implWt!, aiOptions));

      if (await claude.hasNewCommits(implWt, repo.defaultBranch) && await claude.hasTreeDiff(implWt, repo.defaultBranch)) {
        await claude.pushBranch(implWt, implBranch, fullName);
        const prBody = improvement.body + FOOTER;
        const prNumber = await gh.createPR(fullName, implBranch, `refactor: ${improvement.title}`, prBody);
        log.info(`[improvement-identifier] Created PR for "${improvement.title}" in ${fullName}`);
        notify({ jobName: "improvement-identifier", message: `Created PR #${prNumber} for ${fullName}`, url: gh.pullUrl(fullName, prNumber) });
      } else {
        log.warn(`[improvement-identifier] No commits produced for "${improvement.title}" in ${fullName}`);
      }

      db.recordTaskComplete(implTaskId);
    } catch (err) {
      db.recordTaskFailed(implTaskId, String(err));
      reportError("improvement-identifier:implement", `${fullName}: ${improvement.title}`, err);
    } finally {
      if (implWt) {
        await claude.removeWorktree(repo, implWt);
      }
    }
  });

  await Promise.allSettled(tasks);
}

export async function run(repos: Repo[]): Promise<void> {
  const tasks = repos.map((repo) =>
    processRepo(repo).catch((err) =>
      reportError("improvement-identifier:process-repo", repo.fullName, err),
    ),
  );
  await Promise.allSettled(tasks);
}
