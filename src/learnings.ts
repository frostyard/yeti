import * as claude from "./claude.js";
import type { AiOptions } from "./claude.js";
import * as db from "./db.js";
import * as log from "./log.js";
import { LEARNINGS_PENDING_THRESHOLD } from "./config.js";

const YETI_LEARNINGS_PER_RUN_MAX = 5;

export interface RepoLearning {
  path: string;
  summary: string;
}

export interface ParsedLearnings {
  declared: boolean;
  repo: RepoLearning[];
  yeti: string[];
}

/** Extract the machine-readable Learnings declaration from an agent's output. */
export function parseLearnings(output: string): ParsedLearnings {
  const repo: RepoLearning[] = [];
  const yeti: string[] = [];
  let declared = false;

  for (const m of output.matchAll(/^\s*LEARNINGS-REPO:\s*(.*)$/gim)) {
    declared = true;
    const value = m[1].trim();
    if (!value || value.toLowerCase() === "none") continue;
    const fileMatch = value.match(/^(\S+\.md)\s*:\s*(.+)$/);
    if (fileMatch) repo.push({ path: fileMatch[1], summary: fileMatch[2].trim() });
  }

  for (const m of output.matchAll(/^\s*LEARNINGS-YETI:\s*(.*)$/gim)) {
    declared = true;
    const value = m[1].trim();
    if (!value || value.toLowerCase() === "none") continue;
    yeti.push(value);
  }

  return { declared, repo, yeti };
}

/** Remove declaration lines from output destined for GitHub comments/PR bodies. */
export function stripLearningsDeclaration(output: string): string {
  const firstDeclaration = output.search(/^\s*LEARNINGS-(REPO|YETI):.*$/im);
  if (firstDeclaration === -1) return output;

  const head = output.slice(0, firstDeclaration);
  const tail = output
    .slice(firstDeclaration)
    .replace(/^\s*LEARNINGS-(REPO|YETI):.*$/gim, "")
    .replace(/\n{3,}/g, "\n\n");

  return (head + tail).trimEnd();
}

let consolidatorTrigger: (() => void) | null = null;

/** Wired from main.ts to scheduler.triggerJob("learning-consolidator"). */
export function setConsolidatorTrigger(fn: () => void): void {
  consolidatorTrigger = fn;
}

export interface GateContext {
  jobName: string;
  /** Target repo fullName — recorded with the learning. */
  repo: string;
  wtPath: string;
  /** Branch the worktree's tree-diff is checked against (defaultBranch or PR head). */
  baseBranch: string;
  aiOptions?: AiOptions;
}

const RETRY_PROMPT = [
  `Your previous response was missing the required Learnings declaration.`,
  ``,
  `Review the work you just completed in this directory (check \`git log\` and \`git diff\` if needed). Do NOT write any new files or create any new commits — this is a reporting step only. If your session already committed a learning file under \`yeti/learnings/\`, reference it; if you hit friction with this managed environment or its tooling, summarize it in one line.`,
  ``,
  `Then reply with ONLY these two lines (use \`none\` where there is nothing to report):`,
  ``,
  `LEARNINGS-REPO: none`,
  `LEARNINGS-YETI: none`,
  ``,
  `Replace \`none\` as appropriate:`,
  `LEARNINGS-REPO: yeti/learnings/<slug>.md: <one-line summary>`,
  `LEARNINGS-YETI: <one-line environment/tooling learning>`,
].join("\n");

/**
 * Mechanical gate of the self-improvement loop. Applied after the main runAI
 * call in work jobs. Missing declaration → one retry in the same worktree.
 * Claimed repo learnings are verified against the actual yeti/ tree diff.
 * Environment learnings are persisted; hitting the pending threshold triggers
 * the consolidator. NEVER throws — learnings are best-effort.
 */
export async function enforceLearnings(output: string, ctx: GateContext): Promise<void> {
  try {
    let parsed = parseLearnings(output);

    if (!parsed.declared) {
      log.info(`[learnings] ${ctx.jobName}: no Learnings declaration — re-prompting once`);
      const retry = await claude.resolveEnqueue(ctx.aiOptions)(
        () => claude.runAI(RETRY_PROMPT, ctx.wtPath, ctx.aiOptions),
      );
      parsed = parseLearnings(retry);
    }

    if (!parsed.declared) {
      log.warn(`[learnings] ${ctx.jobName}: no Learnings declaration after retry — skipping`);
      return;
    }

    if (parsed.repo.length > 0) {
      const hasYetiDiff = await claude.hasTreeDiff(ctx.wtPath, ctx.baseBranch, "yeti/");
      if (hasYetiDiff) {
        log.info(`[learnings] ${ctx.jobName}: ${parsed.repo.length} repo learning(s) committed under yeti/`);
      } else {
        log.warn(`[learnings] ${ctx.jobName}: declared repo learning(s) but no yeti/ changes in worktree — ignoring claim`);
      }
    }

    const yetiLearnings = parsed.yeti.slice(0, YETI_LEARNINGS_PER_RUN_MAX);
    const pendingBefore = yetiLearnings.length > 0 ? db.countPendingLearnings("yeti") : 0;

    for (const summary of yetiLearnings) {
      db.insertLearning(ctx.jobName, ctx.repo, "yeti", summary);
      log.info(`[learnings] ${ctx.jobName}: recorded environment learning: ${summary}`);
    }

    if (yetiLearnings.length > 0) {
      const pendingAfter = db.countPendingLearnings("yeti");
      if (
        pendingBefore < LEARNINGS_PENDING_THRESHOLD &&
        pendingAfter >= LEARNINGS_PENDING_THRESHOLD
      ) {
        consolidatorTrigger?.();
      }
    }
  } catch (err) {
    log.warn(`[learnings] gate failed for ${ctx.jobName}: ${err}`);
  }
}
