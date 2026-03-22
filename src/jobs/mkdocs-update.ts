import fs from "node:fs";
import path from "node:path";
import { JOB_AI, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";
import { notify } from "../notify.js";

function buildMkdocsPrompt(fullName: string): string {
  return [
    `You are updating MkDocs documentation for the repository ${fullName}.`,
    ``,
    `The source code is the single source of truth. Your goal is to update the`,
    `MkDocs documentation to accurately reflect the current state of the code.`,
    `When the documentation conflicts with the source code, the source code is`,
    `always right. Do not invent features or behaviors — only document what`,
    `exists in the code.`,
    ``,
    `Steps:`,
    `1. Read \`yeti/OVERVIEW.md\` if it exists, for architecture context.`,
    `2. Read \`mkdocs.yml\` (or \`mkdocs.yaml\`) to understand the docs structure`,
    `   and identify the docs directory (default: \`docs/\`).`,
    `3. Scan recent git history (\`git log --oneline -50\`) to identify source`,
    `   code changes since the documentation was last updated.`,
    `4. Read the source code files that changed to understand what actually`,
    `   changed.`,
    `5. Update only the Markdown files under the MkDocs docs directory (and`,
    `   \`mkdocs.yml\` itself if the nav structure needs it). Do NOT modify`,
    `   source code, \`yeti/\` docs, or binary/media files.`,
    `6. If no documentation updates are needed (no meaningful source changes),`,
    `   make no commits.`,
    `7. Commit changes with message: "docs: update mkdocs content [mkdocs-update]"`,
    ``,
    `Do NOT make any source code changes. Only update documentation.`,
  ].join("\n");
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
    const prompt = buildMkdocsPrompt(fullName);
    const aiOptions = JOB_AI["mkdocs-update"];
    const enqueueFn = aiOptions?.backend === "copilot" ? claude.enqueueCopilot : claude.enqueue;
    await enqueueFn(() => claude.runAI(prompt, wtPath!, aiOptions));

    // Step 4: Push and create PR
    if (await claude.hasNewCommits(wtPath, repo.defaultBranch) && await claude.hasTreeDiff(wtPath, repo.defaultBranch)) {
      const description = await claude.generateDocsPRDescription(wtPath, repo.defaultBranch);
      await claude.pushBranch(wtPath, branchName);
      const prNumber = await gh.createPR(
        fullName,
        branchName,
        `docs: update mkdocs content for ${repo.name}`,
        description,
      );
      log.info(`[mkdocs-update] Created PR #${prNumber} for ${fullName}`);
      notify(`[mkdocs-update] Created PR #${prNumber} for ${fullName}`);
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
