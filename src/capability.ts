import { repoAutonomy, DEFAULT_AUTONOMY, AUTONOMY_MAP, type Repo } from "./config.js";
import type { Autonomy } from "./policy.js";

export type Action = "comment" | "label" | "reaction" | "createIssue" | "push" | "createPR" | "merge";

const TIER_RANK: Record<Autonomy, number> = { advisory: 0, issues: 1, pr: 2, automerge: 3 };
const ACTION_MIN_TIER: Record<Action, Autonomy> = {
  comment: "advisory", label: "advisory", reaction: "advisory",
  createIssue: "issues", push: "pr", createPR: "pr", merge: "automerge",
};

/** Thrown by the firewall when a repo's tier disallows an action. Expected control flow, not a crash. */
export class AutonomyError extends Error {
  readonly fullName: string;
  readonly action: Action;
  readonly tier: Autonomy;
  constructor(fullName: string, action: Action, tier: Autonomy) {
    super(`autonomy: '${action}' not permitted for ${fullName} at tier '${tier}'`);
    this.name = "AutonomyError";
    this.fullName = fullName;
    this.action = action;
    this.tier = tier;
  }
}

/** Resolve a tier from a repo fullName alone (firewall path — no Repo object available). */
export function fullNameAutonomy(fullName: string): Autonomy {
  return AUTONOMY_MAP[fullName] ?? DEFAULT_AUTONOMY;
}

/** Pre-flight capability check. Resolves the tier via repoAutonomy, which is identical to fullNameAutonomy (AUTONOMY_MAP ?? DEFAULT). */
export function can(repo: Repo, action: Action): boolean {
  return TIER_RANK[repoAutonomy(repo)] >= TIER_RANK[ACTION_MIN_TIER[action]];
}

/** Firewall assertion (has only the fullName). Throws AutonomyError if disallowed. */
export function assertCapability(fullName: string, action: Action): void {
  const tier = fullNameAutonomy(fullName);
  if (TIER_RANK[tier] < TIER_RANK[ACTION_MIN_TIER[action]]) {
    throw new AutonomyError(fullName, action, tier);
  }
}
