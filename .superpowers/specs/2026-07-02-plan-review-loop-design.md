# Plan Review Loop: Convergent Adversarial Review — Design

**Date:** 2026-07-02
**Status:** Approved design, pending implementation plan
**Goal:** Make the issue-refiner → plan-reviewer loop converge autonomously (`reviewLoop: true`) to a plan the human can approve in one read, instead of churning findings indefinitely.

## Evidence

Two production threads on frostyard/updex demonstrate the failure:

- **updex#84** (worst case): 7 plan/review rounds, no resolution, issue ended with zero labels. Reviews repeatedly re-flagged the `UpdateSymlink` API removal that the maintainer explicitly approved twice in comments (one review literally noted the approval was "not grounded anywhere in the codebase/context you provided" — the reviewer never sees the thread). Reviews contradicted each other across rounds (round 3 demanded designing around the `Target.Path` default; round 4 called the resulting change unjustified scope). Findings churned because every round reviewed a from-scratch plan rewrite with no memory.
- **updex#118** (mild case): a single review whose top findings re-litigated the plan's explicitly stated narrow-scope assumption and its non-blocking clarifying questions (review finding 1 ≈ plan's own question 2), plus scope expansion (add `--quiet` to the daemon unit) that the refiner is forbidden from doing. No verdict, no signal for the human.

Live config on selfie:yeti has `reviewLoop` unset (= off) — every review historically went straight to `Ready`; #84's rounds were human-relabel cycles.

## Root causes

1. **Context starvation.** `buildReviewPrompt()` passes only `ISSUE_BODY` + `PLAN_BODY`. The reviewer never sees maintainer feedback, prior reviews, or refiner responses.
2. **No convergence contract.** The prompt is "find problems"; there is no severity bar, no requirement to disposition prior findings, no prohibition on re-raising settled decisions.
3. **From-scratch replan on kickback.** Reviewer NEEDS REVISION → `Needs Refinement` label → `issue-refiner.run()` routes "plan exists + label" to `processIssue()` → `buildNewPlanPrompt()` (full rewrite, review buried in generic comments section). The disciplined `issue-refiner.refine.md` policy is never used by the loop.
4. **Mechanical bugs.** Review dedup is a 👍 reaction by `selfLogin` on the plan comment: breaks on identity switch (bketelsen → frostyardyeti re-reviewed a 5-day-old plan) and never re-arms when the plan comment is edited in place. `countPlanRounds()` counts all `## Plan Review` comments over the issue lifetime (no reset on human input). Verdict exists only when `reviewLoop` is on. Worktree absolute paths (`/home/yeti/.yeti/worktrees/...`) leak into posted reviews as dead links.

## Decisions made during brainstorming

- **Goal: autonomous convergence.** `reviewLoop: true` becomes the intended operating mode.
- **Human gate stays.** APPROVED → `Ready`; the human still adds `Refined` to start implementation. No auto-proceed, regardless of repo autonomy.
- Cross-model review (refiner=copilot, reviewer=codex via `jobAi`) is preserved; nothing assumes a backend.

---

## Section 1 — The review contract

### Severity taxonomy (two tiers only)

- **Blocking** — implementing the plan *as written* would: fail an explicit requirement of the issue; break existing behavior/build/tests; rest on a codebase claim that is factually wrong (reviewer must have read the file to assert this); or contradict an explicit maintainer decision in the thread.
- **Advisory** — everything else (test-coverage suggestions, doc completeness, risk framing, style, "consider also"). Advisories never gate approval. The refiner may adopt or decline them freely.

### Verdict rule (mechanical)

Zero Blocking findings → `VERDICT: APPROVED` (open advisories allowed). One or more → `VERDICT: NEEDS REVISION`. No gestalt opinions ("directionally right but not solid" is banned by construction).

### Review comment format

```markdown
## Plan Review

Round 2 of 3

### Prior findings
- R1-B1: ✅ resolved — plan now guards same-directory cleanup
- R1-B2: ❌ not resolved — early-return path still skips cleanup
- R1-A1: ➖ settled by maintainer (comment 2026-03-24), dropped

### Blocking
- [R2-B1] `installTransfer` early-return skips legacy cleanup — violates issue req 3
  (updex/install.go:36)

### Advisory
- [R2-A1] `GetActiveVersion` has no direct tests today; worth adding while touching it

**Verdict: NEEDS REVISION** (1 blocking)
```

- Finding IDs `R<round>-B<n>` / `R<round>-A<n>` are stable handles across rounds.
- File references are repo-relative `path:line`. Never absolute/worktree paths.
- Round 1 omits the `### Prior findings` section.

### Refiner's side of the contract

A loop revision must produce a `### Review Response` dispositioning **every** finding by ID — *accepted* (what changed) or *declined* (concrete technical reason) — and revise the plan as a **targeted edit** of the existing plan, preserving untouched sections verbatim. Every Blocking finding must be fixed or declined-with-evidence; Advisories may be adopted or declined freely.

### Convergence rules (the ratchet)

1. **Maintainer comments are binding.** Anything a human decided in-thread is settled fact; re-raising it is forbidden. If the plan follows a maintainer instruction, the decision is correct by definition — review the execution, not the decision.
2. **Stated assumptions and `Clarifying Questions (non-blocking)` are the plan's declared contract.** The reviewer may contradict an assumption only as a Blocking finding with evidence from the issue text or thread; otherwise those belong to the human.
3. **Closure before novelty.** Prior findings are dispositioned (resolved / not resolved / settled) before any new findings. A new Blocking finding in round 2+ must state why it was not visible in the prior round (introduced by the revision, or newly verified fact).
4. **Verify before assert.** Every Blocking finding cites a file the reviewer actually opened this session.
5. **No scope expansion.** Work the issue does not require is Advisory at most.
6. **Findings state a failure.** What breaks, which requirement is violated, or which claim is false. "Could be more robust" is not a finding.

A declined-with-evidence Blocking finding that the next review accepts becomes "settled" — honest disagreements converge instead of ping-ponging.

---

## Section 2 — Reviewer context assembly and prompt

### Daemon-assembled context (in `src/jobs/plan-reviewer.ts`)

`buildReviewPrompt()` gains two template inputs, built deterministically from the `comments` array the job already fetches:

- **`THREAD_SECTION`** — the full comment thread in order, rendered like `buildNewPlanPrompt()` renders comments, with two changes: human (non-yeti, non-bot) comments are labeled `MAINTAINER (binding):`; the current plan comment is elided (it is passed separately as `PLAN_BODY`). Prior reviews and refiner `### Review Response` / `### Note` comments arrive as part of the thread — this is the reviewer's memory.
- **`ROUND_INFO`** — "This is review round N of MAX." On the final round, append: "If nothing rises to Blocking, approve — do not manufacture findings."

The full thread is passed untruncated (context starvation is the root failure; plan reviews are infrequent). If cost ever becomes a problem, summarizing rounds older than the last two is a later optimization — explicitly not built now.

### `src/policies/plan-reviewer.md` rewrite

New structure (final wording at implementation time):

1. Role: adversarial review of the plan for `${FULL_NAME}#${ISSUE_NUMBER}`, round `${ROUND_INFO}`; the review gates implementation.
2. Inputs: issue, `${THREAD_SECTION}`, `${PLAN_BODY}`.
3. Ground rules = the six convergence rules from Section 1.
4. Severity definitions, verbatim from Section 1.
5. Output format: the exact comment skeleton, ending with `VERDICT: APPROVED` or `VERDICT: NEEDS REVISION` on its own line.
6. Keep: read `yeti/OVERVIEW.md` first; no code changes; text output only.

The `${VERDICT_BLOCK}` template variable is removed — the verdict instruction lives in the policy file permanently (see Section 4.3).

---

## Section 3 — Refiner revision path

### Routing change in `issue-refiner.run()`

The "plan exists + `Needs Refinement` label" branch becomes a three-way decision, in priority order:

1. **Unreacted human comments exist** → existing `processRefinement()` (human feedback outranks the loop). If a fresh review also exists, include it in the same revision so one round absorbs both.
2. **Latest yeti `## Plan Review` comment is newer than the plan comment's last edit** → reviewer kickback → new `processReviewRevision()`.
3. **Neither** (human manually re-added the label with no new input) → `processIssue()` fresh replan — preserved as the deliberate "start over" escape hatch.

### `processReviewRevision()` (new, in `src/jobs/issue-refiner.ts`)

Mirrors `processRefinement()`: same worktree lifecycle, **edits the plan comment in place** (plan = single source of truth; GitHub retains edit history), reacts 👍 to consumed human comments. Differences:

- Renders new policy **`src/policies/issue-refiner.revise.md`** (sibling of `refine.md`, which remains for human feedback). Content: disposition each finding ID (accepted → what changed / declined → concrete technical reason); targeted edits only, preserve untouched sections verbatim; every Blocking finding fixed or declined-with-evidence; Advisories optional; same preservation/scope/output rules as `refine.md`.
- The `### Review Response` section is split out of the AI output and posted as a **separate comment** (reusing the existing `### Note` split mechanism in `processRefinement`), so the plan comment stays a clean plan and the reviewer sees the response in `THREAD_SECTION` next round.
- Label choreography on completion: remove `Needs Refinement`, add `Needs Plan Review` (re-arms the reviewer). If the revision surfaces blocking clarifying questions, `isPlanActionable()` handles it as today: no label, wait for human.

---

## Section 4 — Loop mechanics

### 4.1 Version-aware review dedup (replaces reactions)

Every posted review appends an invisible marker:

```
<!-- yeti-review-of:<planCommentId>:<planUpdatedAt> -->
```

The reviewer job skips a plan iff a review comment exists whose marker matches the plan comment's current `(id, updatedAt)` pair. Fixes: identity-independence (no re-review after App/identity switches), automatic re-arm when the plan is edited in place, and provides the "review newer than plan edit" routing signal for Section 3. The 👍-on-plan-comment reaction is dropped.

Implementation note: `getIssueComments()` must expose `updated_at`; extend the `gh` field list / `IssueComment` type if it doesn't already.

### 4.2 Round counting resets on human input

`countPlanRounds()` becomes: count yeti `## Plan Review` comments posted **after the most recent human (non-yeti, non-bot) comment** (or all reviews if no human has commented). A maintainer comment resets the budget — correct, since it changes ground truth. Max rounds (`maxPlanRounds`, default 3) keeps today's terminal behavior: warning comment → remove `Needs Plan Review` → add `Ready`; the final review's Blocking list shows the human exactly what's unresolved.

### 4.3 Verdict, always

- Verdict instruction lives in `plan-reviewer.md` permanently; `buildReviewPrompt()` loses the conditional `VERDICT_BLOCK` and the `reviewLoop` parameter distinction for prompt-building.
- Posted comment renders the verdict human-readable (e.g. `**Verdict: NEEDS REVISION** (2 blocking)`) instead of stripping it.
- `parseVerdict()` keeps the safe default (missing → needs-revision) and logs a warning when the verdict line is absent.
- `reviewLoop: false` behavior unchanged label-wise (always → `Ready`), but the review now carries a verdict as the human's one-read signal.

### 4.4 Worktree path scrubbing

New helper `scrubWorktreePaths(text, wtPath)` in `src/claude.ts` (it owns worktree lifecycle and path conventions): strips the worktree absolute prefix from output, plus a defensive regex for `/home/<user>/.yeti/worktrees/<owner>/<repo>/<job>/<branch>/` variants. Applied to posted output in plan-reviewer and both refiner paths.

### 4.5 Config and dashboard

No new config fields. `reviewLoop` and `maxPlanRounds` already exist; enabling the loop is a config flip on selfie:yeti after deploy. Verify during implementation that both are in the `buildConfigUpdate()` whitelist (`src/api.ts`) and the Config form (`web/src/routes/Config.tsx`); they predate this change.

### 4.6 Documentation

Update `CLAUDE.md` (workflow description of the review loop), `yeti/` docs (OVERVIEW and any job-flow docs describing plan-reviewer/issue-refiner), and `README.md` if it describes the loop.

---

## Testing (TDD, per repo convention)

- **`src/jobs/plan-reviewer.test.ts`**: verdict parsing (present/missing/case variants); marker emission; skip-if-reviewed; re-arm after plan edit (updatedAt change); round counting resets after human comment; label transitions for approved / needs-revision / max-rounds; path scrubbing applied to posted body; `THREAD_SECTION` marks humans `MAINTAINER (binding)` and elides the plan comment; `ROUND_INFO` present and final-round variant.
- **`src/jobs/issue-refiner.test.ts`**: three-way routing priority (human feedback > review kickback > label-only replan); `processReviewRevision` edits plan in place, posts `### Review Response` as separate comment, swaps labels correctly, handles blocking clarifying questions.
- **Manual replay**: run the new reviewer prompt against updex#84's plan v3 + full thread; verify it does not re-raise the settled `UpdateSymlink` decision and produces a verdict with correctly tiered findings.

## Out of scope

- Structured findings storage in SQLite, multi-lens review panels, adversarial verification of findings (Approach C) — revisit only if the contract loop demonstrably fails to converge.
- Thread summarization for long issues.
- Changing the `Refined` human gate or autonomy-dependent auto-proceed.
- prompt-evaluator interplay (it A/B tests plan-producing prompts; the new reviewer policy becomes eligible material for it later, no changes now).

## Rollout

1. Ship the change (normal release flow).
2. Set `reviewLoop: true` on selfie:yeti (jobs are currently paused — unpause issue-refiner/plan-reviewer when ready).
3. Re-run the pipeline on a sandbox issue (like #118 was) to observe a full converging loop before pointing it at real work.
