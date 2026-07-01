# Policy Templates Step 2 — Plan B (Migration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every job's AI prompt(s) out of inline TypeScript into `src/policies/*.md` templates, one job per task, each characterized by a test proving the render is behavior-preserving, then delete the inline builders.

**Architecture:** Uses the Plan A engine (`renderPolicy(job, autonomy, vars)`, dotted-variant names, `repoAutonomy`). Each distinct prompt string that feeds `runAI` becomes one template file. Structurally-different prompts within a job become dotted variants (`<job>.<variant>.md`); small optional inserts become `"" | content` vars. No inline fallbacks are retained.

**Tech Stack:** TypeScript 6 (ESM, Node16), Vitest 4.

## Global Constraints

- **Depends on Plan A** (foundation) being merged: `findMissingVars`, `countPolicyFiles`, `repoAutonomy` using `AUTONOMY_MAP`/`DEFAULT_AUTONOMY`.
- Import sibling modules with the `.js` extension. Templates live in `src/policies/`; the build copies them to `dist/policies` (already wired in Step 1).
- A "prompt" = any string passed to `claude.runAI(...)` (directly or via `resolveEnqueue(...)(() => runAI(prompt, ...))`).
- The transform is **verbatim**: copy the existing inline prompt text into the `.md` unchanged, and replace each JS interpolation `${expr}` with a `${VAR}` placeholder, supplying `VAR: String(expr)` (or the raw string) at the call site. Do not reword prompts.
- Characterization tests are **trailing-whitespace-tolerant** (`.trimEnd()` on both sides), matching Step 1's issue-worker tests — a template file's final newline is harmless.
- **No inline fallbacks.** After a job's characterization test is green, delete the inline prompt array/string. If a template is genuinely missing at runtime, `renderPolicy` throws and the job's existing `try/catch` + `error-reporter` surfaces it.
- **Out of scope** (no `runAI` call, no prompt): `auto-merger`, `repo-standards`, `issue-auditor`. Do not create templates for these. Their autonomy behavior is enforced in code, unchanged.
- Verify each task with the job's own test file (e.g. `npx vitest run src/jobs/<job>.test.ts`), not the whole suite (`src/db.test.ts` fails locally on a `better-sqlite3` native-ABI issue unrelated to this work).

---

## The Migration Recipe (applied by every task below)

Each per-job task performs these six steps. The exemplar (Task 1) shows them fully worked; every later task applies the identical recipe with the job's own data from the Worklist.

1. **Enumerate** the job's prompts: `grep -n 'runAI' src/jobs/<job>.ts` and read each prompt built above those calls. Each distinct prompt → one template name (see Worklist).
2. **Write the characterization test** in `src/jobs/<job>.test.ts`: reconstruct the pre-migration prompt inline in the test, call the (exported) prompt-builder, assert `render.trimEnd() === expected.trimEnd()`. If the job builds the prompt inline in `run`/`processX` without a named builder, first **extract** it into an exported pure function `buildXPrompt(autonomy, ...inputs): string` (no behavior change) so it is unit-testable.
3. **Run the test — it must FAIL** (`renderPolicy` throws: no template file yet). This is the RED gate.
4. **Author the template(s)** in `src/policies/<name>.md` — verbatim text with `${VAR}` placeholders.
5. **Wire** the builder to `renderPolicy("<name>", autonomy, vars)`; delete the inline array/string. Pass `repoAutonomy(repo)` from the call site (thread `autonomy` into the builder as the first parameter).
6. **Run the test — it must PASS**, then **commit** (`git add src/jobs/<job>.ts src/jobs/<job>.test.ts src/policies/…; git commit -m "refactor(<job>): render prompt from policy template"`).

---

### Task 1: issue-worker — add `.phased` variant, remove inline builders (exemplar)

**Files:**
- Modify: `src/jobs/issue-worker.ts`
- Create: `src/policies/issue-worker.phased.md`
- Test: `src/jobs/issue-worker.test.ts`

**Interfaces:**
- Consumes: `renderPolicy` (Plan A), `repoAutonomy` (Plan A), existing `buildPrompt(autonomy, fullName, issue, plan, currentPhase, totalPhases, mergedPRs, comments, imageContext)` (Step 1 exported it and migrated the single-phase branch).
- Produces: `buildPrompt` with **both** branches template-backed and **no** inline fallback.

- [ ] **Step 1: Write the failing characterization test for the multi-phase branch**

Add to the `describe("buildPrompt single-phase (policy template)")` area of `src/jobs/issue-worker.test.ts` a sibling block. Reconstruct the pre-migration multi-phase output (copy the current multi-phase array from `issue-worker.ts` into the test as `expectedPhased`), then:

```ts
import * as planParser from "../plan-parser.js";

describe("buildPrompt multi-phase (policy template)", () => {
  const plan = {
    preamble: "Overall approach.",
    totalPhases: 2,
    phases: [
      { phaseNumber: 1, title: "Schema", description: "Add the table." },
      { phaseNumber: 2, title: "API", description: "Expose the endpoint." },
    ],
  } as unknown as planParser.ParsedPlan;
  const issue = { number: 7, title: "Fix bug", body: "It crashes.", labels: [] } as unknown as gh.Issue;
  const mergedPRs = [{ number: 40, title: "Schema" }] as unknown as gh.PR[];

  function expectedPhased(): string {
    const currentPhase = 2, totalPhases = 2;
    const phase = plan.phases[currentPhase - 1];
    return [
      `You are working on PR ${currentPhase} of ${totalPhases} for issue #${issue.number} in acme/widget.`,
      `Issue: ${issue.title}`,
      ``,
      `If \`yeti/OVERVIEW.md\` exists, read it first (and any linked documents that seem relevant to the issue) for context about the codebase.`,
      ``,
      `## Full Plan`,
      plan.preamble,
      ...plan.phases.map((p) => `### PR ${p.phaseNumber}: ${p.title}\n${p.description}`),
      ``,
      `## Already Completed`,
      mergedPRs.map((pr) => `- PR #${pr.number}: ${pr.title}`).join("\n"),
      ``,
      `## Your Task`,
      `Implement ONLY the changes for PR ${currentPhase}: ${phase.title}`,
      ``,
      phase.description,
      ``,
      `Do NOT implement changes from other phases.`,
      `Make commits with clear messages as you work.`,
      "",
    ].join("\n");
  }

  it("renders the phased variant identically to the pre-migration inline builder", () => {
    const out = buildPrompt("pr", "acme/widget", issue, plan, 2, 2, mergedPRs, [], "");
    expect(out.trimEnd()).toBe(expectedPhased().trimEnd());
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/jobs/issue-worker.test.ts`
Expected: FAIL — `renderPolicy` throws `No policy found for job "issue-worker.phased"` (template not authored yet).

- [ ] **Step 3: Author `src/policies/issue-worker.phased.md`**

Create the file with the multi-phase text, parameterized. `COMPLETED` and `PLAN_PHASES` are pre-assembled by the builder (approach A):

```markdown
You are working on PR ${CURRENT_PHASE} of ${TOTAL_PHASES} for issue #${NUM} in ${REPO}.
Issue: ${TITLE}

If `yeti/OVERVIEW.md` exists, read it first (and any linked documents that seem relevant to the issue) for context about the codebase.

## Full Plan
${PREAMBLE}
${PLAN_PHASES}

## Already Completed
${COMPLETED}

## Your Task
Implement ONLY the changes for PR ${CURRENT_PHASE}: ${PHASE_TITLE}

${PHASE_DESCRIPTION}

Do NOT implement changes from other phases.
Make commits with clear messages as you work.
${IMAGE_CONTEXT}
```

- [ ] **Step 4: Rewrite `buildPrompt` to render both branches, no fallback**

Replace the entire `buildPrompt` body in `src/jobs/issue-worker.ts`. The single-phase branch keeps its Step 1 template call but **drops the `fallback` option**; the multi-phase branch renders the new variant:

```ts
export function buildPrompt(
  autonomy: Autonomy,
  fullName: string,
  issue: gh.Issue,
  plan: planParser.ParsedPlan | null,
  currentPhase: number,
  totalPhases: number,
  mergedPRs: gh.PR[],
  comments: gh.IssueComment[],
  imageContext: string,
): string {
  if (totalPhases === 1 || !plan) {
    return renderPolicy("issue-worker", autonomy, {
      REPO: fullName,
      NUM: String(issue.number),
      TITLE: issue.title,
      BODY: issue.body,
      COMMENTS: formatComments(comments),
      IMAGE_CONTEXT: imageContext,
    });
  }

  const phase = plan.phases[currentPhase - 1];
  const planPhases = plan.phases
    .map((p) => `### PR ${p.phaseNumber}: ${p.title}\n${p.description}`)
    .join("\n");
  const completed = mergedPRs.length > 0
    ? mergedPRs.map((pr) => `- PR #${pr.number}: ${pr.title}`).join("\n")
    : `None yet — this is the first PR.`;

  return renderPolicy("issue-worker.phased", autonomy, {
    CURRENT_PHASE: String(currentPhase),
    TOTAL_PHASES: String(totalPhases),
    NUM: String(issue.number),
    REPO: fullName,
    TITLE: issue.title,
    PREAMBLE: plan.preamble,
    PLAN_PHASES: planPhases,
    COMPLETED: completed,
    PHASE_TITLE: phase.title,
    PHASE_DESCRIPTION: phase.description,
    IMAGE_CONTEXT: imageContext,
  });
}
```

Note: `formatComments` already exists (Step 1). The `singlePhaseInline` fallback closure from Step 1 is now removed.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/jobs/issue-worker.test.ts`
Expected: PASS — single-phase (Step 1 tests), multi-phase (new), and the job flow tests all green.

- [ ] **Step 6: Commit**

```bash
git add src/jobs/issue-worker.ts src/jobs/issue-worker.test.ts src/policies/issue-worker.phased.md
git commit -m "refactor(issue-worker): render phased prompt from template, drop inline fallback"
```

---

### Tasks 2–11: Per-job migration (apply the Recipe)

Each row below is **one task and one commit**, applying the six-step Recipe. `Prompts` is the number of distinct `runAI` prompts to migrate (confirm by reading the file). `Templates` are the filenames to create in `src/policies/`. `Discriminator` names the condition that selects a dotted variant (approach B) when a job has structurally-different prompts; where blank, all prompts share one skeleton with approach-A vars.

| # | Job file | Prompts | Templates (`src/policies/…`) | Discriminator / notes |
|---|----------|---------|------------------------------|-----------------------|
| 2 | `review-addresser.ts` | 1 | `review-addresser.md` | flat, single prompt |
| 3 | `doc-maintainer.ts` | 1 | `doc-maintainer.md` | flat |
| 4 | `mkdocs-update.ts` | 1 | `mkdocs-update.md` | flat |
| 5 | `plan-reviewer.ts` | 1 | `plan-reviewer.md` | 1 prompt reused across 2 `runAI` calls — one template |
| 6 | `triage-yeti-errors.ts` | 1 | `triage-yeti-errors.md` | flat (2 branch hits are label filters, not prompt branches — verify) |
| 7 | `ci-fixer.ts` | up to 4 | `ci-fixer.md`, `ci-fixer.conflict.md` (+ others found) | one template per distinct prompt (CI-fix vs merge-conflict, etc.). Name by purpose. |
| 8 | `issue-refiner.ts` | up to 4 | `issue-refiner.md`, plus one per distinct prompt found | discriminator per refine stage; name by purpose |
| 9 | `improvement-identifier.ts` | 2–3 | one per distinct prompt found | name by purpose |
| 10 | `prompt-evaluator.ts` | up to 6 | one per distinct prompt found | **A/B prompt harness** — migrate only the *fixed* scaffold prompts; leave any prompt whose text is itself the experiment variable inline, and note it in the commit body |
| 11 | `issue-worker.ts` PR-description prompts (optional) | 3 | `pr-description.md`, `pr-description.docs.md`, `pr-description.regen.md` | these live in `claude.ts` (`generatePRDescription`, `generateDocsPRDescription`, `regeneratePRDescription`), not a job. Migrate only if you want prompt parity; otherwise skip and note as deferred. |

**Canonical per-row steps (identical to the Recipe; shown once):**

- [ ] **Step 1:** `grep -n 'runAI' src/jobs/<job>.ts`; read each prompt. If prompt-building is inline in `run`/`processX`, extract it into an exported pure `buildXPrompt(autonomy, ...inputs): string` with no behavior change.
- [ ] **Step 2:** Write the characterization test in `src/jobs/<job>.test.ts`: reconstruct each pre-migration prompt inline as `expected`, call the builder, assert `out.trimEnd() === expected.trimEnd()`. For jobs with multiple prompts, one `it` per prompt.
- [ ] **Step 3:** Run `npx vitest run src/jobs/<job>.test.ts` — expect FAIL (`renderPolicy` throws: template missing).
- [ ] **Step 4:** Author each `src/policies/<name>.md` — verbatim text, `${VAR}` placeholders; pre-assemble any conditional block into a `"" | content` var.
- [ ] **Step 5:** Wire the builder(s) to `renderPolicy(...)`, thread `repoAutonomy(repo)` from the call site, delete the inline prompt string(s).
- [ ] **Step 6:** Run `npx vitest run src/jobs/<job>.test.ts` — expect PASS. Then `git add` the job, its test, and its templates; commit `refactor(<job>): render prompt(s) from policy template`.

---

### Task 12: Selective autonomy variants

**Files:**
- Create: variant templates under `src/policies/` (exact set determined below)
- Test: relevant `src/jobs/*.test.ts`

**Interfaces:** Consumes migrated base templates from Tasks 1–11.

- [ ] **Step 1: Identify jobs whose prompt must change by autonomy tier**

Run: `grep -rln 'push\|createPR\|merge\|commit' src/jobs/*.ts` and review which migrated jobs instruct the agent to create PRs / push. A tier-specific variant is warranted only where the *prompt wording* must differ (e.g. an advisory tier that says "post findings only, do not open a PR"). List the concrete set (expected: `ci-fixer-advisory`, and any prompt-producing job that should be read-only under `advisory`). If none survive review, this task is a no-op — record that and skip to Self-Review.

- [ ] **Step 2: For each identified job, write a failing test at that tier**

Example for `ci-fixer` (adapt names to the real builder):

```ts
it("advisory tier renders the advisory variant (no push instructions)", () => {
  const out = buildCiFixerPrompt("advisory", /* …inputs… */);
  expect(out).toContain("do not push");
  expect(out).not.toContain("git push");
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/jobs/<job>.test.ts`
Expected: FAIL — the advisory variant file does not exist, so `renderPolicy("<job>", "advisory", …)` resolves the base template (which contains push instructions).

- [ ] **Step 4: Author `src/policies/<job>-advisory.md`**

Copy the base template, edit the action instructions to the advisory wording (post findings / open an issue instead of a PR; no push/merge).

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/jobs/<job>.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/policies/<job>-advisory.md src/jobs/<job>.test.ts
git commit -m "feat(policy): advisory-tier variant for <job>"
```

---

### Task 13: Full-suite verification and build

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 2: Run the migrated-job + engine tests**

Run: `npx vitest run src/policy.test.ts src/config.test.ts src/jobs/`
Expected: PASS for all job and engine tests. (`src/db.test.ts` is excluded here because of the known local `better-sqlite3` native-ABI failure; it is unaffected by this work.)

- [ ] **Step 3: Build and confirm every template is copied**

Run: `npm run build && ls dist/policies/`
Expected: build exits 0; `dist/policies/` lists every `.md` created across Tasks 1–12. `copy-policies` prints the count.

- [ ] **Step 4: Grep for leftover inline prompts**

Run: `grep -rn "You are \|## Your Task\|Make commits with clear messages" src/jobs/*.ts | grep -v ".test.ts"`
Expected: no matches in non-test job source (all prose now lives in `src/policies/`). Any hit is an un-migrated prompt — migrate it before considering the plan done.

- [ ] **Step 5: Commit any final cleanup**

```bash
git add -A
git commit -m "chore(policy): Step 2 migration verification"
```

---

## Self-Review

**Spec coverage:**
- §3 job migration → Tasks 1–11 (recipe + worklist). Out-of-scope jobs (`auto-merger`, `repo-standards`, `issue-auditor`) explicitly excluded per the scan (no `runAI`).
- §3 selective variants → Task 12 (gated on a real review; no-op allowed).
- §1a variant files in practice → Task 1 (`issue-worker.phased`) and multi-prompt jobs (Tasks 7–9).
- §4 characterization + tier tests → every task's test steps.
- §3 "remove inline fallbacks" → Task 1 Step 4, Recipe Step 5, and Task 13 Step 4 grep gate.
- Build-copy coverage → Task 13 Step 3.

**Placeholder scan:** The worklist intentionally says "prompts found" / "adapt names" because the exact prompt text and builder names are read from each job at execution time (the transform is verbatim copy, not novel code). The Recipe and the fully-worked exemplar (Task 1) supply the concrete pattern; Task 13's grep gate is the objective completion check. No `TBD`/`TODO`/"add error handling"-style placeholders remain.

**Type consistency:** `buildPrompt(autonomy, …)` signature matches Step 1 and Plan A's `repoAutonomy`/`renderPolicy`. New builders follow the `buildXPrompt(autonomy, …inputs): string` shape. Template var names (`REPO`, `NUM`, `TITLE`, `BODY`, `COMMENTS`, `IMAGE_CONTEXT`, and the phased set `CURRENT_PHASE`/`TOTAL_PHASES`/`PREAMBLE`/`PLAN_PHASES`/`COMPLETED`/`PHASE_TITLE`/`PHASE_DESCRIPTION`) are consistent between Task 1's template and builder.

**Scope note:** Tasks 7–10 have variable prompt counts (2–6 each). If any single job's migration proves large (e.g. `prompt-evaluator`), split it into one task per prompt rather than one per job — each prompt+template+test+commit is already an independently reviewable unit.
