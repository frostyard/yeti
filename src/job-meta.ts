// Shared job metadata used by the scheduler wiring, the JSON API, and (legacy) HTML pages.

export interface JobInfo {
  name: string;
  intervalMs: number;
  scheduledHour?: number;
}

export const JOB_DESCRIPTIONS: Record<string, string> = {
  "issue-refiner": "Generates implementation plans for issues needing refinement",
  "plan-reviewer": "Adversarial AI review of generated implementation plans",
  "issue-worker": "Implements Refined issues as pull requests",
  "ci-fixer": "Fixes failing CI checks and resolves merge conflicts",
  "review-addresser": "Addresses review comments on Yeti pull requests",
  "triage-yeti-errors": "Investigates and triages internal Yeti error issues",
  "doc-maintainer": "Nightly documentation generation and updates",
  "auto-merger": "Auto-merges Dependabot and approved Yeti PRs",
  "repo-standards": "Syncs labels and cleans up legacy labels across repos",
  "improvement-identifier": "Identifies codebase improvements and implements as PRs",
  "mkdocs-update": "Daily MkDocs documentation update from recent changes",
  "issue-auditor": "Daily audit ensuring no issues fall between the cracks",
  "prompt-evaluator": "A/B tests plan-producing prompts against AI-generated variants, files issues for improvements",
  "learning-consolidator": "Consolidates agent-reported environment learnings into policies via PR",
};
