import type { IssueComment } from "./github.js";
import { isYetiComment } from "./github.js";

/** Header of every review comment plan-reviewer posts. */
export const REVIEW_HEADER = "## Plan Review";

const VERDICT_RE = /^VERDICT:\s*(APPROVED|NEEDS\s+REVISION)\s*[.!?)\]]*\s*$/i;

/**
 * Invisible marker embedded in each posted review, binding it to the exact
 * plan version it reviewed. planUpdatedAt changes when the plan comment is
 * edited in place, which re-arms the reviewer automatically.
 */
export function reviewMarker(planCommentId: number, planUpdatedAt: string): string {
  return `<!-- yeti-review-of:${planCommentId}:${planUpdatedAt} -->`;
}

/** The yeti review of this exact plan version, if one was already posted. */
export function findReviewOfPlanVersion(
  comments: IssueComment[],
  planCommentId: number,
  planUpdatedAt: string,
): IssueComment | undefined {
  const marker = reviewMarker(planCommentId, planUpdatedAt);
  return comments.findLast((c) => isYetiComment(c.body) && c.body.includes(marker));
}

/** Last VERDICT: line wins; "missing" lets the caller log cross-check failures. */
export function parseVerdict(output: string): "approved" | "needs-revision" | "missing" {
  const lines = output.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].trim().match(VERDICT_RE);
    if (m) return m[1].toUpperCase() === "APPROVED" ? "approved" : "needs-revision";
  }
  return "missing";
}

/** Counts `- [R<n>-B<n>]` finding bullets, optionally segment-prefixed, in the Blocking list only. */
export function countBlockingFindings(output: string): number {
  let inBlocking = false;
  let count = 0;

  for (const line of output.split("\n")) {
    if (/^\s*###\s+Blocking\b/i.test(line)) {
      inBlocking = true;
      continue;
    }
    if (/^\s*###\s+/i.test(line)) {
      inBlocking = false;
      continue;
    }
    if (inBlocking && /^\s*-\s*\[(?:S\d+-)?R\d+-B\d+\]/.test(line)) {
      count++;
    }
  }

  return count;
}

/** Replace the raw VERDICT: line with the computed bold human-readable form for the posted comment. */
export function renderVerdict(output: string, verdict: "approved" | "needs-revision"): string {
  const block =
    verdict === "approved"
      ? "**Verdict: APPROVED**"
      : `**Verdict: NEEDS REVISION** (${countBlockingFindings(output)} blocking)`;
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().match(VERDICT_RE)) {
      lines[i] = block;
      return lines.join("\n").trim();
    }
  }
  return `${output.trim()}\n\n${block}`.trim();
}

/**
 * Completed review rounds for the current loop: yeti reviews posted after the
 * most recent human comment. A maintainer comment changes ground truth, so it
 * resets the round budget.
 */
export function countPlanRounds(comments: IssueComment[]): number {
  const lastHumanIdx = comments.findLastIndex(
    (c) => !isYetiComment(c.body) && !c.login.endsWith("[bot]"),
  );
  return comments
    .slice(lastHumanIdx + 1)
    .filter((c) => c.body.includes(REVIEW_HEADER) && isYetiComment(c.body)).length;
}

/**
 * Loop segment index used to disambiguate finding IDs across human-comment
 * resets. Uses the same non-Yeti, non-bot human-comment boundary as
 * countPlanRounds() so the segment and budget counter stay in lockstep.
 */
export function countSegments(comments: IssueComment[]): number {
  return comments.filter((c) => !isYetiComment(c.body) && !c.login.endsWith("[bot]")).length + 1;
}
