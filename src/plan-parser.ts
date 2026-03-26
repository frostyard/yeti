export const PLAN_HEADER = "## Implementation Plan";

export interface PlanPhase {
  phaseNumber: number;
  title: string;
  description: string;
}

export interface ParsedPlan {
  preamble: string;
  phases: PlanPhase[];
  totalPhases: number;
}

/**
 * Parse a structured plan comment into discrete phases.
 * Looks for `### PR N:` or `### Phase N:` headers to split into phases.
 * Falls back to a single phase if no multi-PR structure is found.
 */
export function parsePlan(planComment: string): ParsedPlan {
  const headerPattern = /^###\s+(?:PR|Phase)\s+(\d+)\s*:\s*(.+)$/gm;
  const matches = [...planComment.matchAll(headerPattern)];

  if (matches.length === 0) {
    return {
      preamble: planComment,
      phases: [{ phaseNumber: 1, title: "Implementation", description: planComment }],
      totalPhases: 1,
    };
  }

  const preamble = planComment.slice(0, matches[0].index).trim();

  const phases: PlanPhase[] = matches.map((match, i) => {
    const phaseNumber = parseInt(match[1], 10);
    const title = match[2].trim();
    const start = match.index! + match[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : planComment.length;
    const description = planComment.slice(start, end).trim();
    return { phaseNumber, title, description };
  });

  return { preamble, phases, totalPhases: phases.length };
}

/**
 * Returns false if the plan contains blocking clarifying questions,
 * indicating the planner needs user input before a review is useful.
 *
 * - `### Clarifying Questions (non-blocking)` → actionable (review proceeds)
 * - `### Clarifying Questions (blocking)` → not actionable (skip review)
 * - `### Clarifying Questions` (no suffix) → not actionable (safe default)
 */
export function isPlanActionable(planOutput: string): boolean {
  if (/^###\s+Clarifying Questions\s+\(non-blocking\)/m.test(planOutput)) return true;
  return !/^###\s+Clarifying Questions/m.test(planOutput);
}

/**
 * Find the most recent plan comment in a list of issue comments.
 * Looks for comments containing `## Implementation Plan` (uses includes
 * rather than startsWith so it still matches when the Yeti visible header
 * is prepended).
 */
export function findPlanComment(comments: { body: string }[]): string | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i].body.includes(PLAN_HEADER)) {
      return comments[i].body;
    }
  }
  return null;
}
