import fs from "node:fs";
import path from "node:path";
import { JOB_AI, repoAutonomy, type Repo } from "../config.js";
import { renderPolicy, type Autonomy } from "../policy.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";
import { notify } from "../notify.js";

export function buildMkdocsPrompt(autonomy: Autonomy, fullName: string): string {
  return renderPolicy("mkdocs-update", autonomy, {
    REPO: fullName,
  });
}

async function processRepo(repo: Repo): Promise<void> {
  const fullName = repo.fullName;

  // Step 1: Check for existing open mkdocs-update PR
  const prs = await gh.listPRs(fullName);
  const hasMkdocsPR = prs.some((pr) => pr.headRefName.startsWith("yeti/mkdocs-update-"));
  if (hasMkdocsPR) {
    log.info(`[mkdocs-update] Skipping ${fullName} — open mkdocs-update PR exists`);
    return;
  }

  // Step 2: Create worktree and check for mkdocs config
  const branchName = `yeti/mkdocs-update-${claude.datestamp()}-${claude.randomSuffix()}`;
  const taskId = db.recordTaskStart("mkdocs-update", fullName, 0, null);
  let wtPath: string | undefined;

  try {
    wtPath = await claude.createWorktree(repo, branchName, "mkdocs-update");
    db.updateTaskWorktree(taskId, wtPath, branchName);

    // Check for mkdocs.yml or mkdocs.yaml
    const hasMkdocsYml = fs.existsSync(path.join(wtPath, "mkdocs.yml"));
    const hasMkdocsYaml = fs.existsSync(path.join(wtPath, "mkdocs.yaml"));
    if (!hasMkdocsYml && !hasMkdocsYaml) {
      log.info(`[mkdocs-update] Skipping ${fullName} — no mkdocs.yml or mkdocs.yaml`);
      db.recordTaskComplete(taskId);
      return;
    }

    // Step 3: Run AI to update docs
    log.info(`[mkdocs-update] Updating mkdocs content for ${fullName}`);
    const prompt = buildMkdocsPrompt(repoAutonomy(repo), fullName);
    const aiOptions = JOB_AI["mkdocs-update"];
    await claude.resolveEnqueue(aiOptions)(() => claude.runAI(prompt, wtPath!, aiOptions));

    // Step 4: Push and create PR
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
