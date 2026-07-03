# Autonomy Enforcement — Design (Plan C)

**Date:** 2026-07-01
**Status:** Approved
**Depends on:** Step 2 (`feat/policy-templates`) — `repoAutonomy(repo)`, `DEFAULT_AUTONOMY`, `AUTONOMY_MAP`, `Autonomy` type (`advisory | issues | pr | automerge`) in `src/config.ts`/`src/policy.ts`.

## Problem

After Step 2, `repoAutonomy` resolves a per-repo tier but it is used **only** to select a policy template — and no tier-suffixed templates exist, so every tier renders the same base prompt. **No code consults autonomy to gate side effects.** Setting a repo to `advisory` today does not stop the bot from opening PRs or pushing. The knob is cosmetic (see the "Follow-up" section of `2026-07-01-policy-templates-step2-design.md`). This plan makes it real.

## Goal

Enforce the autonomy tier with **skip semantics**: a job simply does not perform an action its repo's tier disallows (no downgrade prose, no advisory templates). Enforcement is **defense-in-depth** — a pre-flight check that skips before spending AI, plus an unbypassable firewall in the low-level write functions.

## Design decisions (resolved)

| Decision | Choice |
|----------|--------|
| Gate behavior | **Skip** — job does not act on repos above its tier; no downgrade, no advisory-variant templates. |
| Enforcement layers | **Both** — pre-flight (job entry, before AI) + firewall (write functions throw). |
| Advisory floor (always allowed) | **Comments + labels + reactions** (and all reads). Not gated at any tier. |
| Firewall denial | Throws `AutonomyError`; the error-reporter **logs and skips** it (no `[yeti-error]` issue) — a policy denial is not a crash. |

## Tier → capability mapping

Tiers are ordinal: `advisory (0) < issues (1) < pr (2) < automerge (3)`.

| Action | Min tier | Always-allowed at |
|--------|----------|-------------------|
| `comment` | advisory | all tiers |
| `label` (add/remove) | advisory | all tiers |
| `reaction` | advisory | all tiers |
| `createIssue` | issues | issues, pr, automerge |
| `push` | pr | pr, automerge |
| `createPR` | pr | pr, automerge |
| `merge` | automerge | automerge only |

Rationale for the floor: labels/reactions/comments are internal workflow state and commentary, not outward-created artifacts; gating them would tangle the label-driven state machine. This matches Hive's advisory model (advisory posts findings, never issues/PRs/merges).

## 1. Capability module — new `src/capability.ts`

Pure, single-responsibility. Depends only on `config.ts` (for autonomy resolution) and the `Repo` type.

```ts
import { repoAutonomy, DEFAULT_AUTONOMY, AUTONOMY_MAP, type Repo } from "./config.js";
import type { Autonomy } from "./policy.js";

export type Action = "comment" | "label" | "reaction" | "createIssue" | "push" | "createPR" | "merge";

const TIER_RANK: Record<Autonomy, number> = { advisory: 0, issues: 1, pr: 2, automerge: 3 };
const ACTION_MIN_TIER: Record<Action, Autonomy> = {
  comment: "advisory", label: "advisory", reaction: "advisory",
  createIssue: "issues", push: "pr", createPR: "pr", merge: "automerge",
};

export class AutonomyError extends Error {
  readonly fullName: string;
  readonly action: Action;
  readonly tier: Autonomy;
  constructor(fullName: string, action: Action, tier: Autonomy) {
    super(`autonomy: '${action}' not permitted for ${fullName} at tier '${tier}'`);
    this.name = "AutonomyError";
    this.fullName = fullName; this.action = action; this.tier = tier;
  }
}

/** Resolve a tier from a repo fullName alone (firewall path; no Repo object). */
export function fullNameAutonomy(fullName: string): Autonomy {
  return AUTONOMY_MAP[fullName] ?? DEFAULT_AUTONOMY;
}

/** Pre-flight check (has the Repo object). */
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
```

Note: `fullNameAutonomy` does not consult `repo.autonomy` (the per-Repo escape-hatch field) because the firewall only has a fullName. `repo.autonomy` is effectively unused in practice; the per-repo map keyed by fullName is the real source. Pre-flight (`can`) uses full `repoAutonomy` precedence. This is a deliberate, documented minor asymmetry.

## 2. Pre-flight gate (skip before AI spend)

Each side-effecting job, at the top of its per-item/per-repo processing, checks its **primary** action and returns early (logging a skip) when the tier is insufficient — before creating worktrees or calling the AI.

| Job | Primary action | Gate |
|-----|----------------|------|
| issue-worker | createPR | `if (!can(repo, "createPR")) { log.info(skip); return; }` |
| doc-maintainer | createPR | same |
| mkdocs-update | createPR | same |
| improvement-identifier | createPR | same |
| ci-fixer | push | `if (!can(repo, "push")) ...` |
| review-addresser | push | same |
| auto-merger | merge | `if (!can(repo, "merge")) ...` |
| issue-refiner | comment | none — always runs |
| plan-reviewer | comment | none — always runs |
| repo-standards | (labels only) | none — always runs |
| issue-auditor | (no writes) | none — always runs |

The skip log line names the repo, tier, and required action, e.g. `[issue-worker] skip owner/repo — tier 'advisory' < required 'pr'`.

## 3. Firewall (unbypassable net)

The low-level write functions assert before performing the side effect:

- `src/github.ts`: `createIssue(repo, …)` → `assertCapability(repo, "createIssue")`; `createPR(repo, …)` → `assertCapability(repo, "createPR")`; `mergePR(repo, …)` → `assertCapability(repo, "merge")`. (These already receive `repo: string` = fullName.)
- `src/claude.ts`: `pushBranch(wtPath, branchName)` currently has **no** repo context. Add a `fullName: string` parameter → `pushBranch(wtPath, branchName, fullName)` and `assertCapability(fullName, "push")`. Update its ~6 call sites (issue-worker, doc-maintainer, mkdocs-update, improvement-identifier, ci-fixer, review-addresser) to pass the repo fullName.

In normal operation the pre-flight prevents ever reaching the firewall; a firewall throw therefore signals a call site that bypassed the gate — a real bug, surfaced (see §4).

## 4. Error-reporter special-case

`src/error-reporter.ts`'s `reportError` currently files/annotates a `[yeti-error]` GitHub issue. Add an early branch: if the error `instanceof AutonomyError`, `log.warn` it and return without filing an issue. A policy denial is expected control flow, not a crash, and must not create issue noise. (Jobs' existing `try/catch` still catch it; the job aborts that item cleanly.)

## 5. Testing

- **`capability.test.ts`:** `can` and `assertCapability` across every (tier × action) pair — assert the exact allow/deny boundary for all four tiers; `assertCapability` throws `AutonomyError` with correct fields when denied and is silent when allowed; `fullNameAutonomy` honors `AUTONOMY_MAP` then `DEFAULT_AUTONOMY`.
- **Per-job pre-flight:** for each gated job, a test that at an insufficient tier the job returns early and does **not** call the AI/worktree (assert `runAI`/`createWorktree` not called), and at a sufficient tier it proceeds. Reuse each job's existing test harness + the `repoAutonomy` mock (set the mock to return the tier under test).
- **Firewall:** `createPR`/`createIssue`/`mergePR`/`pushBranch` throw `AutonomyError` at an insufficient tier and succeed at a sufficient tier (mock `assertCapability`/autonomy as needed).
- **Error-reporter:** `reportError(new AutonomyError(...))` logs and does not call the issue-creating path.

All under vitest. Known caveat: `src/db.test.ts` fails locally under Node 26 (`better-sqlite3` native-ABI) — unrelated; verify with the specific test files.

## 6. Sequencing (one plan, phased)

1. **Capability module:** `src/capability.ts` (`Action`, mapping, `can`, `assertCapability`, `fullNameAutonomy`, `AutonomyError`) + its tests.
2. **Firewall + error-reporter:** guards in `github.ts` (createIssue/createPR/mergePR), `pushBranch` signature change + guard in `claude.ts` and its call sites, and the `AutonomyError` special-case in `error-reporter.ts` + tests.
3. **Per-job pre-flight gates:** the 7 gated jobs, one at a time, each with a skip/run test.

## Non-goals

- No advisory-variant templates (skip semantics render them unnecessary).
- No dashboard/config-UI display of tier (later polish).
- No change to the `repo.autonomy` per-Repo field behavior (unused escape hatch; left as-is).

---

## Rollout notes (behavior changes for operators)

Plan C makes the autonomy tier enforcing (previously cosmetic). Two operator-visible changes:

1. **auto-merge now requires opt-in.** The default tier is `pr`, and `merge` requires `automerge`. So after this change, auto-merger **no longer merges any repo unless that repo is explicitly mapped to `automerge`** in `config.json` (`"autonomy": { "owner/repo": "automerge" }`). Operators who relied on default-config auto-merge must add the mapping. (Enforcement is intended and test-covered.)
2. **Lower tiers make the bot progressively read-only.** `advisory` repos: comments/labels/reactions only (no issues/PRs/pushes/merges). `issues`: adds issue creation. `pr`: adds push + PR creation (human merges). Jobs whose primary action exceeds a repo's tier now **skip that repo** (logged), before spending AI.

## Follow-ups (non-blocking, from final review)

- Hoist issue-worker/review-addresser pre-flight gates from per-item to the per-repo loop (cosmetic: avoids repeated skip logs + a wasted list read at low tiers; no AI spend today).
- Resolve the `repoAutonomy` (pre-flight, honors `repo.autonomy`) vs `fullNameAutonomy` (firewall, ignores it) asymmetry: `repo.autonomy` is never populated today so they always agree, but either drop the dead `Repo.autonomy` field or make the firewall share the precedence before anyone wires it.
