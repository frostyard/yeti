# Autonomy Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the per-repo autonomy tier actually gate side effects (skip semantics) via a pre-flight check in each job plus an unbypassable firewall in the low-level write functions.

**Architecture:** A new pure `src/capability.ts` derives, from `repoAutonomy`, whether a repo may perform an action (`comment`/`label`/`reaction` always; `createIssue` at `issues`+; `push`/`createPR` at `pr`+; `merge` at `automerge`). Jobs call `can(repo, action)` at entry and skip before spending AI. The write functions (`createIssue`/`createPR`/`mergePR`/`pushBranch`) call `assertCapability(fullName, action)` and throw `AutonomyError`, which the error-reporter logs without filing an issue.

**Tech Stack:** TypeScript 6 (ESM, Node16 modules), Vitest 4, Node 22+ runtime.

## Global Constraints

- Node runtime 22 (ESM). Import sibling modules with the `.js` extension.
- `Autonomy` type (`advisory | issues | pr | automerge`) is owned by `src/policy.ts`; import it type-only where only the type is needed.
- Tier order is ordinal: `advisory (0) < issues (1) < pr (2) < automerge (3)`.
- Always-allowed floor (every tier, incl. advisory): `comment`, `label`, `reaction`, and all reads. Gated: `createIssue` (issues+), `push` (pr+), `createPR` (pr+), `merge` (automerge only).
- Enforcement is defense-in-depth: pre-flight `can(repo, action)` at job entry (skip before AI) AND firewall `assertCapability(fullName, action)` inside write functions (throws).
- `AutonomyError` is expected control flow, not a crash: `error-reporter` logs it and does NOT file a `[yeti-error]` issue.
- Skip semantics only — no downgrade, no advisory-variant templates.
- Tests live beside source as `*.test.ts`. Run one file: `npx vitest run <path>`. `src/db.test.ts` fails locally under Node 26 (`better-sqlite3` native-ABI) — unrelated; verify with the named files, not the whole suite.

---

### Task 1: Capability module

**Files:**
- Create: `src/capability.ts`
- Test: `src/capability.test.ts`

**Interfaces:**
- Consumes: `repoAutonomy(repo: Repo): Autonomy`, `DEFAULT_AUTONOMY: Autonomy`, `AUTONOMY_MAP: Readonly<Record<string, Autonomy>>`, `type Repo` — all from `./config.js`; `type Autonomy` from `./policy.js`.
- Produces:
  - `type Action = "comment" | "label" | "reaction" | "createIssue" | "push" | "createPR" | "merge"`
  - `class AutonomyError extends Error` with readonly `fullName: string`, `action: Action`, `tier: Autonomy`
  - `fullNameAutonomy(fullName: string): Autonomy`
  - `can(repo: Repo, action: Action): boolean`
  - `assertCapability(fullName: string, action: Action): void` (throws `AutonomyError`)

- [ ] **Step 1: Write the failing test**

Create `src/capability.test.ts`. It mocks `./config.js` so the module under test resolves autonomy deterministically:

```ts
import { describe, it, expect } from "vitest";
import { vi } from "vitest";

vi.mock("./config.js", () => ({
  // repoAutonomy honors an explicit repo.autonomy for the pre-flight `can` tests
  repoAutonomy: (r: { autonomy?: string }) => r?.autonomy ?? "pr",
  DEFAULT_AUTONOMY: "pr",
  AUTONOMY_MAP: { "acme/advisory-repo": "advisory", "acme/merge-repo": "automerge" },
}));

import { can, assertCapability, fullNameAutonomy, AutonomyError, type Action } from "./capability.js";

const repo = (autonomy?: string) => ({ owner: "acme", name: "r", fullName: "acme/r", defaultBranch: "main", ...(autonomy ? { autonomy } : {}) }) as unknown as import("./config.js").Repo;

describe("fullNameAutonomy", () => {
  it("uses AUTONOMY_MAP when present, else DEFAULT_AUTONOMY", () => {
    expect(fullNameAutonomy("acme/advisory-repo")).toBe("advisory");
    expect(fullNameAutonomy("acme/unknown")).toBe("pr");
  });
});

describe("can", () => {
  const cases: Array<[string, Action, boolean]> = [
    ["advisory", "comment", true], ["advisory", "label", true], ["advisory", "reaction", true],
    ["advisory", "createIssue", false], ["advisory", "push", false], ["advisory", "createPR", false], ["advisory", "merge", false],
    ["issues", "createIssue", true], ["issues", "push", false], ["issues", "createPR", false], ["issues", "merge", false],
    ["pr", "createIssue", true], ["pr", "push", true], ["pr", "createPR", true], ["pr", "merge", false],
    ["automerge", "push", true], ["automerge", "createPR", true], ["automerge", "merge", true],
  ];
  for (const [tier, action, expected] of cases) {
    it(`${tier} ${expected ? "can" : "cannot"} ${action}`, () => {
      expect(can(repo(tier), action)).toBe(expected);
    });
  }
});

describe("assertCapability", () => {
  it("is silent when allowed", () => {
    expect(() => assertCapability("acme/merge-repo", "merge")).not.toThrow();
  });
  it("throws AutonomyError with fields when denied", () => {
    try {
      assertCapability("acme/advisory-repo", "createPR");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AutonomyError);
      const err = e as AutonomyError;
      expect(err.fullName).toBe("acme/advisory-repo");
      expect(err.action).toBe("createPR");
      expect(err.tier).toBe("advisory");
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/capability.test.ts`
Expected: FAIL — `Cannot find module './capability.js'`.

- [ ] **Step 3: Implement `src/capability.ts`**

```ts
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

/** Pre-flight capability check (has the Repo object; uses full repoAutonomy precedence). */
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

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/capability.test.ts`
Expected: PASS (all `can`, `assertCapability`, `fullNameAutonomy` cases).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/capability.ts src/capability.test.ts
git commit -m "feat(capability): autonomy capability checks (can/assertCapability)"
```

---

### Task 2: error-reporter special-case for AutonomyError

**Files:**
- Modify: `src/error-reporter.ts` (near the `instanceof` early-returns, ~lines 16-26)
- Test: `src/error-reporter.test.ts`

**Interfaces:**
- Consumes: `AutonomyError` from `./capability.js` (Task 1).

- [ ] **Step 1: Write the failing test**

Add to `src/error-reporter.test.ts` (follow the file's existing setup/mocks; it already mocks `./github.js` and `./log.js`). The key assertion: an `AutonomyError` is logged and does NOT reach the GitHub issue-creating path.

```ts
import { AutonomyError } from "./capability.js";
// gh mock is already present in this file as the github.js mock; reference its createIssue/commentOnIssue spies.

it("does not file a GitHub issue for AutonomyError (logs and returns)", async () => {
  const { reportError } = await import("./error-reporter.js");
  // Use whatever the file names its gh mock; assert the issue-creating spy is NOT called.
  await reportError("autonomy-denied", "issue-worker push", new AutonomyError("acme/r", "push", "advisory"));
  // Assert no issue was created/commented (use the file's existing gh mock handles):
  //   expect(mockGh.createIssue).not.toHaveBeenCalled();
  //   expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
});
```

Adapt the exact mock handle names to those already used in `src/error-reporter.test.ts` (read the file first). If the file mocks `./capability.js`, unmock it or provide a real `AutonomyError` export in the mock.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/error-reporter.test.ts`
Expected: FAIL — without the special-case, `reportError` proceeds past the early-returns toward the issue-creating path (the `not.toHaveBeenCalled()` assertion fails, or the test errors because `AutonomyError` handling is absent).

- [ ] **Step 3: Add the AutonomyError branch**

In `src/error-reporter.ts`, add the import at the top:

```ts
import { AutonomyError } from "./capability.js";
```

Then insert this branch immediately after the `ShutdownError` check (after line ~19, before the `RateLimitError` check), mirroring the existing pattern:

```ts
  // AutonomyError is an expected policy denial (a job attempted an action its
  // repo's tier disallows). Log and skip — never file a [yeti-error] issue.
  if (error instanceof AutonomyError) {
    log.warn(`[${fingerprint}] ${context}: ${error.message} (autonomy denial — not reported)`);
    return;
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/error-reporter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/error-reporter.ts src/error-reporter.test.ts
git commit -m "feat(error-reporter): log-and-skip AutonomyError (no issue filed)"
```

---

### Task 3: Firewall in write functions + pushBranch signature

**Files:**
- Modify: `src/github.ts` (`createIssue` ~L523, `createPR` ~L747, `mergePR` ~L896)
- Modify: `src/claude.ts` (`pushBranch` ~L553)
- Modify: all 10 `pushBranch` call sites — `src/jobs/issue-worker.ts:198`, `improvement-identifier.ts:157`, `doc-maintainer.ts:190`, `ci-fixer.ts:48,62,229,338,378`, `review-addresser.ts:48`, `mkdocs-update.ts:56`
- Test: `src/github.test.ts`, `src/claude.test.ts`

**Interfaces:**
- Consumes: `assertCapability(fullName, action)` and `AutonomyError` from `./capability.js` (Task 1).
- Produces: `pushBranch(wtPath: string, branchName: string, fullName: string): Promise<void>` (new third param).

- [ ] **Step 1: Write the failing tests (firewall invokes assertCapability)**

The write functions must call `assertCapability` before performing their side effect. Test by spying on `./capability.js`. Add to `src/github.test.ts` (follow its existing mock setup; it mocks the `gh` exec helper):

```ts
import * as capability from "./capability.js";

it("createPR asserts createPR capability before creating", async () => {
  const spy = vi.spyOn(capability, "assertCapability").mockImplementation(() => {});
  await createPR("acme/r", "head", "title", "body");
  expect(spy).toHaveBeenCalledWith("acme/r", "createPR");
  spy.mockRestore();
});

it("createPR propagates AutonomyError from the firewall (no PR created)", async () => {
  const spy = vi.spyOn(capability, "assertCapability").mockImplementation(() => {
    throw new capability.AutonomyError("acme/r", "createPR", "advisory");
  });
  await expect(createPR("acme/r", "head", "title", "body")).rejects.toBeInstanceOf(capability.AutonomyError);
  spy.mockRestore();
});
```

Add analogous pairs for `createIssue` (action `"createIssue"`) and `mergePR` (action `"merge"`). In `src/claude.test.ts`, add for `pushBranch` (action `"push"`), calling `pushBranch("/wt", "branch", "acme/r")` and asserting `assertCapability` was called with `("acme/r", "push")`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/github.test.ts src/claude.test.ts`
Expected: FAIL — the `assertCapability` spy is never called (guards absent), and `pushBranch` does not yet accept a third arg.

- [ ] **Step 3: Add guards to `src/github.ts`**

Add the import at the top of `src/github.ts`:

```ts
import { assertCapability } from "./capability.js";
```

As the first statement inside each function body:

- `createIssue(repo, …)`: `assertCapability(repo, "createIssue");`
- `createPR(repo, …)`: `assertCapability(repo, "createPR");`
- `mergePR(repo, prNumber)`: `assertCapability(repo, "merge");`

(`repo` is the fullName string in all three.)

- [ ] **Step 4: Change `pushBranch` signature + guard in `src/claude.ts`**

Add the import at the top of `src/claude.ts`:

```ts
import { assertCapability } from "./capability.js";
```

Change `pushBranch`:

```ts
export async function pushBranch(wtPath: string, branchName: string, fullName: string): Promise<void> {
  assertCapability(fullName, "push");
  // Use HEAD refspec to support both detached HEAD (createWorktreeFromBranch)
  // and named branch (createWorktree) worktrees.
  await git(["push", "origin", `HEAD:refs/heads/${branchName}`], wtPath);
}
```

- [ ] **Step 5: Update all 10 call sites to pass the fullName**

Each call site has the repo fullName in scope. Update each:

- `src/jobs/issue-worker.ts:198`: `await claude.pushBranch(wtPath, branchName, repo.fullName);`
- `src/jobs/improvement-identifier.ts:157`: `await claude.pushBranch(implWt, implBranch, repo.fullName);`
- `src/jobs/doc-maintainer.ts:190`: `await claude.pushBranch(wtPath, branchName, repo.fullName);`
- `src/jobs/ci-fixer.ts:48,62,229,338,378`: `await claude.pushBranch(wtPath, pr.headRefName, repo.fullName);` (confirm the repo variable name in each function's scope — it is `repo: Repo`; use `repo.fullName`)
- `src/jobs/review-addresser.ts:48`: `await claude.pushBranch(wtPath, pr.headRefName, repo.fullName);`
- `src/jobs/mkdocs-update.ts:56`: `await claude.pushBranch(wtPath, branchName, repo.fullName);`

For each file, verify the in-scope repo variable name by reading the enclosing function; if it is named differently (e.g. `repo` vs a destructured value), use the correct `.fullName`.

- [ ] **Step 6: Run the tests + typecheck**

Run: `npx vitest run src/github.test.ts src/claude.test.ts && npx tsc --noEmit`
Expected: firewall tests PASS; `tsc` exit 0 (confirms every `pushBranch` call site now passes 3 args — a missed call site fails compilation).

- [ ] **Step 7: Run the affected job test suites (call-site regression)**

Run: `npx vitest run src/jobs/issue-worker.test.ts src/jobs/ci-fixer.test.ts src/jobs/review-addresser.test.ts src/jobs/doc-maintainer.test.ts src/jobs/mkdocs-update.test.ts src/jobs/improvement-identifier.test.ts`
Expected: PASS. If a job test mocks `claude.pushBranch`, the added arg is transparent; if a test asserts `pushBranch` call args, update it to include the fullName.

- [ ] **Step 8: Commit**

```bash
git add src/github.ts src/claude.ts src/jobs/*.ts src/github.test.ts src/claude.test.ts
git commit -m "feat(firewall): gate createIssue/createPR/mergePR/pushBranch on autonomy"
```

---

### Tasks 4–10: Per-job pre-flight gates (apply the Recipe)

Each row below is **one task and one commit**. The pre-flight check returns early (before any worktree/AI) when the repo's tier is insufficient for the job's primary action.

**The Recipe (identical for every row):**

1. Open `src/jobs/<job>.ts`. Find where it begins processing a single repo/item (the function that later calls `createWorktree`/`runAI` — e.g. `processIssue`/`processPR`/`processRepo`/the `run` loop body). Identify the `Repo` variable in scope (usually `repo`).
2. Add the import (if not already present): `import { can } from "../capability.js";`
3. As the FIRST statement of that per-item processing (before any label change, worktree, or AI call), insert:
   ```ts
   if (!can(repo, "<ACTION>")) {
     log.info(`[<job>] skip ${repo.fullName} — tier below '<ACTION>' requirement`);
     return;
   }
   ```
   Use the row's `<ACTION>` and `<job>`. (`log` is already imported in every job as `import * as log from "../log.js"`.)
4. Write the pre-flight test in `src/jobs/<job>.test.ts`: with the config mock's `repoAutonomy` returning a tier below the requirement (pass a repo built with `autonomy: "advisory"` — the mock is `repoAutonomy: (r) => r?.autonomy ?? "pr"`, so `mockRepo` spread with `autonomy: "advisory"` yields advisory), invoke the job and assert it skipped: `expect(mockClaude.createWorktree).not.toHaveBeenCalled()` and `expect(mockClaude.runAI).not.toHaveBeenCalled()`. Add a second assertion that at a sufficient tier (default `"pr"`, or `"automerge"` for auto-merger) the job proceeds (createWorktree/its main path IS reached) — reuse the job's existing happy-path test if one already asserts this.
   - The job test mocks `../config.js`; ensure that mock exports `repoAutonomy` (all migrated job tests already added it in Plan B). `capability.ts` is NOT mocked — real `can` reads the mocked `repoAutonomy`.
5. Run `npx vitest run src/jobs/<job>.test.ts` — expect the new skip test to FAIL first (no gate yet), then PASS after adding the gate. Then `git add` the job + its test and commit `feat(<job>): pre-flight autonomy gate`.

**Worklist:**

| # | Job | `<ACTION>` | Sufficient tier for the "proceeds" test |
|---|-----|-----------|------------------------------------------|
| 4 | `issue-worker` | `createPR` | `pr` (default) |
| 5 | `doc-maintainer` | `createPR` | `pr` |
| 6 | `mkdocs-update` | `createPR` | `pr` |
| 7 | `improvement-identifier` | `createPR` | `pr` |
| 8 | `ci-fixer` | `push` | `pr` |
| 9 | `review-addresser` | `push` | `pr` |
| 10 | `auto-merger` | `merge` | `automerge` |

Notes:
- **auto-merger** (row 10): its per-item processing is where it decides to `mergePR`. Place the gate at the top of that per-PR processing. Its test harness sets `repoAutonomy` to `"pr"` for the skip case (pr < automerge → skip, no merge) and `"automerge"` for the proceeds case; assert `mockGh.mergePR` not called vs called.
- **ci-fixer** (row 8) has multiple per-PR entry points; place the gate at the single top-level per-PR processing function that all its `pushBranch` paths flow through. If pushes happen in more than one independent entry, gate each with `can(repo, "push")`. The firewall (Task 3) is the backstop, so a missed pre-flight spot degrades to a firewall throw (caught + logged), not an escape.

---

### Task 11: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 2: Run capability + firewall + all job tests**

Run: `npx vitest run src/capability.test.ts src/github.test.ts src/claude.test.ts src/error-reporter.test.ts src/jobs/`
Expected: all PASS.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: exit 0 (tsc + copy-policies).

- [ ] **Step 4: Grep — confirm every gated write is guarded**

Run: `grep -n "assertCapability" src/github.ts src/claude.ts`
Expected: 4 occurrences (createIssue, createPR, mergePR, pushBranch). Confirm each gated write function has its guard.

- [ ] **Step 5: Commit any final cleanup**

```bash
git add -A
git commit -m "chore(autonomy): enforcement verification" --allow-empty
```

---

## Self-Review

**Spec coverage:**
- §1 capability module → Task 1.
- §2 pre-flight gate → Tasks 4–10 (worklist).
- §3 firewall (write fns + pushBranch signature + call sites) → Task 3.
- §4 error-reporter special-case → Task 2.
- §5 testing → each task's test steps + Task 11.
- §6 sequencing (capability → firewall+error-reporter → per-job) → Tasks 1, 2+3, 4–10. (Task 2 precedes Task 3 so `AutonomyError` handling exists before the firewall can throw it in integration.)
- Non-goals (advisory templates, dashboard, repo.autonomy change) → not present, by design.

**Placeholder scan:** Recipe rows say "confirm the repo variable name by reading the enclosing function" because the exact local identifier must be read per file — the action and gate code are fully specified. No `TBD`/`TODO`/"add error handling" placeholders.

**Type consistency:** `can(repo, action)`, `assertCapability(fullName, action)`, `fullNameAutonomy(fullName)`, `AutonomyError(fullName, action, tier)`, `Action` union, and `pushBranch(wtPath, branchName, fullName)` are used identically across Tasks 1, 3, 4–10. Action strings (`createIssue`/`push`/`createPR`/`merge`) match the spec's `ACTION_MIN_TIER` keys exactly.
