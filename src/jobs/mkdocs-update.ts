import fs from "node:fs";
import path from "node:path";
import { JOB_AI, repoAutonomy, type Repo } from "../config.js";
import { renderPolicy, type Autonomy } from "../policy.js";
import { can } from "../capability.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";
import { notify } from "../notify.js";

const JOB_NAME = "mkdocs-update";
const COMMIT_MARKER = "[mkdocs-update]";

export function buildMkdocsPrompt(autonomy: Autonomy, fullName: string): string {
  return renderPolicy(JOB_NAME, autonomy, {
    REPO: fullName,
  });
}

async function processRepo(repo: Repo): Promise<void> {
  if (!can(repo, "createPR")) {
    log.info(`[mkdocs-update] skip ${repo.fullName} — tier below 'createPR' requirement`);
    return;
  }

  const fullName = repo.fullName;

  // Step 1: Check for existing open mkdocs-update PR
  const prs = await gh.listPRs(fullName);
  const hasMkdocsPR = prs.some((pr) => pr.headRefName.startsWith("yeti/mkdocs-update-"));
  if (hasMkdocsPR) {
    log.info(`[mkdocs-update] Skipping ${fullName} — open mkdocs-update PR exists`);
    return;
  }

  // Step 2: Skip before worktree/AI if this repo head was already processed.
  const { sha: headSha, message: headMessage } = await gh.getRemoteHead(fullName, repo.defaultBranch);
  const lastSha = db.getLastJobSha(JOB_NAME, fullName);
  if (lastSha === headSha || headMessage.includes(COMMIT_MARKER)) {
    log.info(`[mkdocs-update] Skipping ${fullName} — no changes since last mkdocs update`);
    db.recordJobSha(JOB_NAME, fullName, headSha);
    return;
  }

  // Step 3: Create worktree and check for mkdocs config
  const branchName = `yeti/mkdocs-update-${claude.datestamp()}-${claude.randomSuffix()}`;
  const taskId = db.recordTaskStart(JOB_NAME, fullName, 0, null);
  let wtPath: string | undefined;

  try {
    wtPath = await claude.createWorktree(repo, branchName, "mkdocs-update");
    db.updateTaskWorktree(taskId, wtPath, branchName);

    // Check for mkdocs.yml or mkdocs.yaml
    const hasMkdocsYml = fs.existsSync(path.join(wtPath, "mkdocs.yml"));
    const hasMkdocsYaml = fs.existsSync(path.join(wtPath, "mkdocs.yaml"));
    if (!hasMkdocsYml && !hasMkdocsYaml) {
      log.info(`[mkdocs-update] Skipping ${fullName} — no mkdocs.yml or mkdocs.yaml`);
      db.recordJobSha(JOB_NAME, fullName, headSha);
      db.recordTaskComplete(taskId);
      return;
    }

    // Step 4: Run AI to update docs
    log.info(`[mkdocs-update] Updating mkdocs content for ${fullName}`);
    const prompt = buildMkdocsPrompt(repoAutonomy(repo), fullName);
    const aiOptions = JOB_AI[JOB_NAME];
    await claude.resolveEnqueue(aiOptions)(() => claude.runAI(prompt, wtPath!, aiOptions));

    // Step 5: Push and create PR
    if (await claude.hasNewCommits(wtPath, repo.defaultBranch) && await claude.hasTreeDiff(wtPath, repo.defaultBranch)) {
      const description = await claude.generateDocsPRDescription(wtPath, repo.defaultBranch, aiOptions);
      await claude.pushBranch(wtPath, branchName, fullName);
      const prNumber = await gh.createPR(
        fullName,
        branchName,
        `docs: update mkdocs content for ${repo.name}`,
        description,
      );
      log.info(`[mkdocs-update] Created PR #${prNumber} for ${fullName}`);
      notify({ jobName: "mkdocs-update", message: `Created PR #${prNumber} for ${fullName}`, url: gh.pullUrl(fullName, prNumber) });
    } else {
      log.warn(`[mkdocs-update] No commits produced for ${fullName}`);
    }

    db.recordJobSha(JOB_NAME, fullName, headSha);
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
  const tasks = repos.map((repo) =>
    processRepo(repo).catch((err) =>
      reportError("mkdocs-update:process-repo", repo.fullName, err),
    ),
  );
  await Promise.allSettled(tasks);
}
