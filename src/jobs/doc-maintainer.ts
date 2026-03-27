import fs from "node:fs";
import path from "node:path";
import { JOB_AI, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";
import { notify } from "../notify.js";
import { findPlanComment } from "../plan-parser.js";

const UPDATE_DOC_DIRECTIVE = `**update documentation** After any change to source code, update relevant documentation in CLAUDE.md, README.md and the yeti/ folder. A task is not complete without reviewing and updating relevant documentation.`;

const YETI_DIR_DIRECTIVE = `**yeti/ directory** The \`yeti/\` directory contains documentation written for AI consumption and context enhancement, not primarily for humans. Jobs like \`doc-maintainer\` and \`issue-worker\` instruct the AI to read \`yeti/OVERVIEW.md\` and related files for codebase context before performing tasks. Write content in this directory to be maximally useful to an AI agent understanding the codebase — detailed architecture, patterns, and decision rationale rather than user-facing guides.`;

const CLAUDE_MD_DOC_SECTION = `\n## Documentation\n\n${UPDATE_DOC_DIRECTIVE}\n\n${YETI_DIR_DIRECTIVE}\n`;

/** Git args for committing CLAUDE.md changes with explicit identity (the yeti system user has no global git config). */
const GIT_COMMIT_CLAUDEMD = ["-c", "user.email=yeti@users.noreply.github.com", "-c", "user.name=Yeti", "commit", "-m", "docs: ensure CLAUDE.md documentation block"];

/**
 * Ensures CLAUDE.md contains the standard ## Documentation block with both
 * required directives. Returns true if the file was modified and committed.
 * Commit message deliberately omits [doc-maintainer] to preserve SHA logic.
 */
export async function ensureClaudeMdDocBlock(wtPath: string): Promise<boolean> {
  const filePath = path.join(wtPath, "CLAUDE.md");

  if (!fs.existsSync(filePath)) {
    const content = `# CLAUDE.md\n\nThis file provides guidance to Claude Code when working with code in this repository.\n${CLAUDE_MD_DOC_SECTION}`;
    fs.writeFileSync(filePath, content);
    await claude.git(["add", "CLAUDE.md"], wtPath);
    await claude.git([...GIT_COMMIT_CLAUDEMD], wtPath);
    return true;
  }

  const content = fs.readFileSync(filePath, "utf-8");

  // Find the ## Documentation section
  const docHeadingMatch = content.match(/^## Documentation\s*$/m);

  if (docHeadingMatch) {
    const sectionStart = docHeadingMatch.index!;
    const afterHeading = sectionStart + docHeadingMatch[0].length;
    // Find next ## heading or EOF
    const nextHeadingMatch = content.slice(afterHeading).match(/^## /m);
    const sectionEnd = nextHeadingMatch
      ? afterHeading + nextHeadingMatch.index!
      : content.length;
    const section = content.slice(sectionStart, sectionEnd);

    const hasUpdate = section.includes("**update documentation**");
    const hasYetiDir = section.includes("**yeti/ directory**");

    if (hasUpdate && hasYetiDir) {
      return false;
    }

    // Append missing directives before the next section
    const missing: string[] = [];
    if (!hasUpdate) missing.push(UPDATE_DOC_DIRECTIVE);
    if (!hasYetiDir) missing.push(YETI_DIR_DIRECTIVE);
    const insertion = "\n" + missing.join("\n\n") + "\n";

    const newContent = content.slice(0, sectionEnd) + insertion + content.slice(sectionEnd);
    fs.writeFileSync(filePath, newContent);
    await claude.git(["add", "CLAUDE.md"], wtPath);
    await claude.git([...GIT_COMMIT_CLAUDEMD], wtPath);
    return true;
  }

  // No ## Documentation section exists — append the full block
  const newContent = content.trimEnd() + CLAUDE_MD_DOC_SECTION;
  fs.writeFileSync(filePath, newContent);
  await claude.git(["add", "CLAUDE.md"], wtPath);
  await claude.git([...GIT_COMMIT_CLAUDEMD], wtPath);
  return true;
}

function buildDocPrompt(fullName: string, planCount = 0): string {
  const lines = [
    `You are maintaining documentation for the repository ${fullName}.`,
    ``,
    `Your goal is to create or update documentation under \`yeti/\` that is`,
    `optimized for providing context when planning and implementing new features`,
    `and bug fixes.`,
    ``,
    `Steps:`,
    `1. Run \`mkdir -p yeti\` to ensure the directory exists.`,
    `2. Read the codebase to understand its current structure, purpose, and key`,
    `   patterns.`,
    `3. If \`yeti/OVERVIEW.md\` exists, read it and all docs it links to, then`,
    `   update them to reflect the current state of the code. Preserve accurate`,
    `   content and update anything outdated. If it doesn't exist, create it`,
    `   from scratch.`,
    `4. \`yeti/OVERVIEW.md\` is the main entry point and should include:`,
    `   - **Purpose**: What this repo does and its role (2-3 sentences)`,
    `   - **Architecture**: Key directories, modules, and how they fit together`,
    `   - **Key Patterns**: Important conventions, data flow, and design decisions`,
    `   - **Configuration**: Key config values and environment variables`,
    `5. For complex subsystems that need detailed coverage, create dedicated`,
    `   documents (e.g., \`yeti/database-schema.md\`, \`yeti/api-design.md\`) and`,
    `   link to them from OVERVIEW.md. Keep each focused on one subject.`,
    `6. Keep OVERVIEW.md concise (200-500 lines). Dedicated docs can be longer`,
    `   as needed for thorough coverage.`,
    `7. Commit with message: "docs: update documentation [doc-maintainer]"`,
    ``,
    `Do NOT make any code changes. Only update documentation.`,
  ];

  if (planCount > 0) {
    lines.push(
      ``,
      `A \`.plans/\` directory has been created in the repo root containing implementation`,
      `plans from ${planCount} recently-closed issues. Each file is named by issue number`,
      `(e.g., \`.plans/42.md\`).`,
      ``,
      `Read these plans and extract any valuable architectural context, design decisions,`,
      `conventions, or patterns into the existing documentation. Only add information that`,
      `is actually reflected in the current codebase. If a plan contains nothing new for`,
      `the docs, skip it. Do NOT commit the \`.plans/\` directory — it is temporary.`,
    );
  }

  return lines.join("\n");
}

async function processRepo(repo: Repo): Promise<void> {
  const fullName = repo.fullName;

  // Step 1: Check for existing open docs PR
  const prs = await gh.listPRs(fullName);
  const hasDocsPR = prs.some((pr) => pr.headRefName.startsWith("yeti/docs-"));
  if (hasDocsPR) {
    log.info(`[doc-maintainer] Skipping ${fullName} — open docs PR exists`);
    return;
  }

  // Step 2: Create worktree and ensure CLAUDE.md documentation block
  const branchName = `yeti/docs-${claude.datestamp()}-${claude.randomSuffix()}`;
  const taskId = db.recordTaskStart("doc-maintainer", fullName, 0, null);
  let wtPath: string | undefined;

  try {
    wtPath = await claude.createWorktree(repo, branchName, "doc-maintainer");
    db.updateTaskWorktree(taskId, wtPath, branchName);

    await ensureClaudeMdDocBlock(wtPath);

    // Step 3: Check if maintenance is needed (SHA comparison)
    const headSha = await claude.getHeadSha(wtPath);
    const lastDocSha = await claude.getLastDocMaintainerSha(wtPath);

    if (lastDocSha && lastDocSha === headSha) {
      log.info(`[doc-maintainer] Skipping ${fullName} — no changes since last doc update`);
      db.recordTaskComplete(taskId);
      return;
    }

    // Step 4: Fetch recently-closed issues with implementation plans
    const sinceDate = lastDocSha
      ? await claude.getCommitDate(wtPath, lastDocSha)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // fallback: 7 days

    const closedIssues = await gh.listRecentlyClosedIssues(fullName, sinceDate);

    const MAX_PLANS = 10;
    const MAX_PLAN_LENGTH = 5_000;
    const plans: { number: number; title: string; plan: string }[] = [];
    for (const issue of closedIssues) {
      if (plans.length >= MAX_PLANS) break;
      const comments = await gh.getIssueComments(fullName, issue.number);
      const plan = findPlanComment(comments);
      if (plan) {
        const truncated = plan.length > MAX_PLAN_LENGTH
          ? plan.slice(0, MAX_PLAN_LENGTH) + "\n\n[... truncated]"
          : plan;
        if (plan.length > MAX_PLAN_LENGTH) {
          log.warn(`[doc-maintainer] Truncated plan for issue #${issue.number} (${plan.length} chars)`);
        }
        plans.push({ number: issue.number, title: issue.title, plan: truncated });
      }
    }

    // Write plans to temporary .plans/ directory
    if (plans.length > 0) {
      const plansDir = path.join(wtPath, ".plans");
      fs.mkdirSync(plansDir, { recursive: true });
      for (const p of plans) {
        const content = `# Issue #${p.number}: ${p.title}\n\n${p.plan}`;
        fs.writeFileSync(path.join(plansDir, `${p.number}.md`), content);
      }
      log.info(`[doc-maintainer] Wrote ${plans.length} plan(s) to .plans/ for ${fullName}`);
    }

    // Step 5: Generate/update documentation
    log.info(`[doc-maintainer] Generating docs for ${fullName}`);
    const prompt = buildDocPrompt(fullName, plans.length);
    const aiOptions = JOB_AI["doc-maintainer"];
    await claude.resolveEnqueue(aiOptions)(() => claude.runAI(prompt, wtPath!, aiOptions));

    // Clean up temporary plans directory (must not be committed)
    const plansDir = path.join(wtPath!, ".plans");
    if (fs.existsSync(plansDir)) {
      fs.rmSync(plansDir, { recursive: true });
      try {
        await claude.git(["rm", "-rf", "--cached", ".plans"], wtPath!);
      } catch {
        // Not staged, that's fine
      }
    }

    // Step 6: Push and create PR
    if (await claude.hasNewCommits(wtPath, repo.defaultBranch) && await claude.hasTreeDiff(wtPath, repo.defaultBranch)) {
      const description = await claude.generateDocsPRDescription(wtPath, repo.defaultBranch, aiOptions);
      await claude.pushBranch(wtPath, branchName);
      const prNumber = await gh.createPR(
        fullName,
        branchName,
        `docs: update documentation for ${repo.name}`,
        description,
      );
      log.info(`[doc-maintainer] Created docs PR #${prNumber} for ${fullName}`);
      notify({ jobName: "doc-maintainer", message: `Created PR #${prNumber} for ${fullName}`, url: gh.pullUrl(fullName, prNumber) });
    } else {
      log.warn(`[doc-maintainer] No commits produced for ${fullName}`);
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
      reportError("doc-maintainer:process-repo", repo.fullName, err),
    ),
  );
  await Promise.allSettled(tasks);
}
