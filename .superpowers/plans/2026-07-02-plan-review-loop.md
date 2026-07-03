# Convergent Plan-Review Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the issue-refiner → plan-reviewer loop converge autonomously to an APPROVED plan by giving the reviewer thread memory, a Blocking/Advisory contract with a mechanical verdict, and a targeted revision path in the refiner.

**Architecture:** A new shared module `src/review-contract.ts` owns the review protocol (header, version marker, verdict parsing/rendering, round counting). `plan-reviewer.ts` assembles full-thread context into a rewritten policy prompt and dedups reviews by a `(planCommentId, planUpdatedAt)` marker instead of reactions. `issue-refiner.ts` gains a three-way routing on the `Needs Refinement` label and a new `processReviewRevision()` that edits the plan in place using a new `issue-refiner.revise.md` policy.

**Tech Stack:** Node.js 22, ESM, strict TypeScript, vitest (mocked `gh`/`claude` boundaries). No new dependencies.

**Spec:** `.superpowers/specs/2026-07-02-plan-review-loop-design.md` (committed on this branch).

## Global Constraints

- Branch: `feat/plan-review-loop` (already exists, spec committed).
- TDD for every code change: write failing test → verify fail → implement → verify pass → commit.
- Run single test files with `npx vitest run <path>`; full gate is `npm test` (typecheck daemon + web, then all tests) — mirrors CI.
- Policy files: `src/policies/*.md`, rendered by `renderPolicy(name, autonomy, vars)` with `${VAR}` substitution; `_preamble.md` is auto-prepended; `scripts/copy-policies.mjs` (already wired into `npm run build:server`) copies all `.md` to `dist/policies` — new policy files need no build changes.
- Yeti comments: `commentOnIssue`/`editIssueComment` automatically wrap bodies with `*— Automated by Yeti —*` header and `<!-- yeti-automated -->` marker; `isYetiComment(body)` detects the marker.
- Severity taxonomy is exactly two tiers: **Blocking** and **Advisory**. Verdict rule: zero Blocking → `VERDICT: APPROVED`, else `VERDICT: NEEDS REVISION`. Finding IDs: `R<round>-B<n>` / `R<round>-A<n>`.
- Review dedup marker format (exact): `<!-- yeti-review-of:<planCommentId>:<planUpdatedAt> -->`.
- Labels (from `LABELS` in `src/config.ts`): `Needs Refinement`, `Needs Plan Review`, `Ready`, `Refined`.
- No new config fields. `reviewLoop`/`maxPlanRounds` already exist in config, `buildConfigUpdate()` whitelist (`src/api.ts:169-171`), and `web/src/routes/Config.tsx` — verified, no dashboard work.
- Human gate stays: APPROVED → `Ready` label only; humans add `Refined`.

---

### Task 1: Add `updatedAt` to `IssueComment`

The review-dedup marker and refiner routing need the plan comment's version (`updated_at` changes when a comment is edited).

**Files:**
- Modify: `src/github.ts:709-724` (`IssueComment` interface + `getIssueComments`)
- Test: `src/github.test.ts` (extend `describe("getIssueComments")` at ~line 1351)

**Interfaces:**
- Produces: `IssueComment { id: number; body: string; login: string; updatedAt: string }` — all later tasks rely on `updatedAt`.

- [ ] **Step 1: Write the failing test**

In `src/github.test.ts`, replace the body of the existing test `"returns comments with id, body, and login, filtering empty bodies"` inside `describe("getIssueComments")`:

```typescript
  it("returns comments with id, body, login, and updatedAt, filtering empty bodies", async () => {
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify([
        { id: 1, body: "First comment", user: { login: "alice" }, updated_at: "2026-07-01T10:00:00Z" },
        { id: 2, body: "  ", user: { login: "bob" }, updated_at: "2026-07-01T11:00:00Z" },
        { id: 3, body: "Third comment", user: { login: "charlie" } },
      ]), "");
    });

    const comments = await getIssueComments("org/repo", 1);
    expect(comments).toEqual([
      { id: 1, body: "First comment", login: "alice", updatedAt: "2026-07-01T10:00:00Z" },
      { id: 3, body: "Third comment", login: "charlie", updatedAt: "" },
    ]);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/github.test.ts -t "returns comments with id, body, login"`
Expected: FAIL — received objects lack `updatedAt`.

- [ ] **Step 3: Implement**

In `src/github.ts`, change the `IssueComment` interface and the mapping in `getIssueComments`:

```typescript
export interface IssueComment {
  id: number;
  body: string;
  login: string;
  /** ISO timestamp of the comment's last edit (updated_at). Changes when a comment is edited in place. */
  updatedAt: string;
}

export async function getIssueComments(repo: string, issueNumber: number): Promise<IssueComment[]> {
  return apiCache.dedupedFetch(`issue-comments:${repo}:${issueNumber}`, 60_000, async () => {
    const raw = await gh([
      "api",
      `repos/${repo}/issues/${issueNumber}/comments`,
    ]);
    const comments = safeJsonParse(raw, "issue comments") as { id: number; body: string; user: { login: string }; updated_at?: string }[];
    return comments.filter((c) => c.body.trim()).map((c) => ({ id: c.id, body: c.body, login: c.user.login, updatedAt: c.updated_at ?? "" }));
  }) as Promise<IssueComment[]>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/github.test.ts -t "returns comments with id, body, login"`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck` — expected clean (the field is additive; test mocks that build comment arrays untyped are unaffected).

```bash
git add src/github.ts src/github.test.ts
git commit -m "feat(github): expose updatedAt on issue comments"
```

---

### Task 2: `src/review-contract.ts` — the shared review protocol

New module owning everything both jobs must agree on. `REVIEW_HEADER`, `parseVerdict`, and round counting move here out of `plan-reviewer.ts` (moved in Task 5; this task creates the module).

**Files:**
- Create: `src/review-contract.ts`
- Test: `src/review-contract.test.ts`

**Interfaces:**
- Consumes: `IssueComment` (Task 1), `isYetiComment` from `src/github.ts`.
- Produces (exact signatures — Tasks 5 and 6 import these):
  - `REVIEW_HEADER: "## Plan Review"`
  - `reviewMarker(planCommentId: number, planUpdatedAt: string): string`
  - `findReviewOfPlanVersion(comments: IssueComment[], planCommentId: number, planUpdatedAt: string): IssueComment | undefined`
  - `parseVerdict(output: string): "approved" | "needs-revision" | "missing"`
  - `countBlockingFindings(output: string): number`
  - `renderVerdict(output: string): string`
  - `countPlanRounds(comments: IssueComment[]): number`

- [ ] **Step 1: Write the failing tests**

Create `src/review-contract.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("./github.js", () => ({
  isYetiComment: (body: string) => body.includes("<!-- yeti-automated -->"),
}));

import {
  REVIEW_HEADER,
  reviewMarker,
  findReviewOfPlanVersion,
  parseVerdict,
  countBlockingFindings,
  renderVerdict,
  countPlanRounds,
} from "./review-contract.js";

const YETI = "<!-- yeti-automated -->";

function comment(over: Partial<{ id: number; body: string; login: string; updatedAt: string }> = {}) {
  return { id: 1, body: "hi", login: "alice", updatedAt: "", ...over };
}

describe("reviewMarker", () => {
  it("encodes plan comment id and updatedAt", () => {
    expect(reviewMarker(501, "2026-07-01T10:00:00Z")).toBe(
      "<!-- yeti-review-of:501:2026-07-01T10:00:00Z -->",
    );
  });
});

describe("findReviewOfPlanVersion", () => {
  const marker = reviewMarker(501, "2026-07-01T10:00:00Z");

  it("finds a yeti review carrying the marker for the exact plan version", () => {
    const review = comment({ id: 601, body: `${YETI}## Plan Review\n\nFindings\n\n${marker}`, login: "yeti[bot]" });
    expect(findReviewOfPlanVersion([comment(), review], 501, "2026-07-01T10:00:00Z")).toBe(review);
  });

  it("returns undefined when the plan was edited after the review (updatedAt mismatch)", () => {
    const review = comment({ id: 601, body: `${YETI}## Plan Review\n\n${marker}` });
    expect(findReviewOfPlanVersion([review], 501, "2026-07-02T09:00:00Z")).toBeUndefined();
  });

  it("ignores marker text in non-yeti comments", () => {
    const spoof = comment({ id: 602, body: `## Plan Review\n${marker}` });
    expect(findReviewOfPlanVersion([spoof], 501, "2026-07-01T10:00:00Z")).toBeUndefined();
  });
});

describe("parseVerdict", () => {
  it("parses APPROVED", () => {
    expect(parseVerdict("All good.\nVERDICT: APPROVED")).toBe("approved");
  });

  it("parses NEEDS REVISION case-insensitively", () => {
    expect(parseVerdict("Problems.\nverdict: needs revision")).toBe("needs-revision");
  });

  it("uses the last verdict line", () => {
    expect(parseVerdict("VERDICT: APPROVED\n...\nVERDICT: NEEDS REVISION")).toBe("needs-revision");
  });

  it("returns missing when no verdict line exists", () => {
    expect(parseVerdict("A review with no conclusion.")).toBe("missing");
  });
});

describe("countBlockingFindings", () => {
  it("counts bracketed blocking finding IDs, not advisories or prior-finding mentions", () => {
    const review = [
      "### Prior findings",
      "- R1-B1: resolved",
      "### Blocking",
      "- [R2-B1] cleanup skipped (updex/install.go:36)",
      "- [R2-B2] wrong default path",
      "### Advisory",
      "- [R2-A1] add a test",
    ].join("\n");
    expect(countBlockingFindings(review)).toBe(2);
  });

  it("returns 0 when there are no blocking findings", () => {
    expect(countBlockingFindings("### Advisory\n- [R1-A1] nit")).toBe(0);
  });
});

describe("renderVerdict", () => {
  it("replaces the verdict line with a bold human-readable form including blocking count", () => {
    const out = renderVerdict("### Blocking\n- [R1-B1] bad\n\nVERDICT: NEEDS REVISION");
    expect(out).toContain("**Verdict: NEEDS REVISION** (1 blocking)");
    expect(out).not.toMatch(/^VERDICT:/m);
  });

  it("renders APPROVED without a count", () => {
    const out = renderVerdict("Looks solid.\nVERDICT: APPROVED");
    expect(out).toContain("**Verdict: APPROVED**");
  });

  it("leaves output without a verdict line unchanged", () => {
    expect(renderVerdict("no verdict here")).toBe("no verdict here");
  });
});

describe("countPlanRounds", () => {
  const review = (id: number) => comment({ id, body: `${YETI}## Plan Review\n\nstuff`, login: "yeti[bot]" });
  const human = (id: number) => comment({ id, body: "please change X", login: "bsherman" });
  const bot = (id: number) => comment({ id, body: "coverage report", login: "codecov[bot]" });

  it("counts all yeti reviews when no human has commented", () => {
    expect(countPlanRounds([review(1), review(2)])).toBe(2);
  });

  it("resets the count after the most recent human comment", () => {
    expect(countPlanRounds([review(1), review(2), human(3), review(4)])).toBe(1);
  });

  it("does not treat [bot] comments as human", () => {
    expect(countPlanRounds([review(1), bot(2), review(3)])).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/review-contract.test.ts`
Expected: FAIL — cannot resolve `./review-contract.js`.

- [ ] **Step 3: Implement**

Create `src/review-contract.ts`:

```typescript
import type { IssueComment } from "./github.js";
import { isYetiComment } from "./github.js";

/** Header of every review comment plan-reviewer posts. */
export const REVIEW_HEADER = "## Plan Review";

const VERDICT_RE = /^VERDICT:\s*(APPROVED|NEEDS\s+REVISION)\s*$/i;

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

/** Last VERDICT: line wins; "missing" lets the caller log before falling back to needs-revision. */
export function parseVerdict(output: string): "approved" | "needs-revision" | "missing" {
  const lines = output.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].trim().match(VERDICT_RE);
    if (m) return m[1].toUpperCase() === "APPROVED" ? "approved" : "needs-revision";
  }
  return "missing";
}

/** Counts `- [R<n>-B<n>]` finding bullets — the Blocking list only, not prior-finding dispositions. */
export function countBlockingFindings(output: string): number {
  return (output.match(/^\s*-\s*\[R\d+-B\d+\]/gm) ?? []).length;
}

/** Replace the raw VERDICT: line with the bold human-readable form for the posted comment. */
export function renderVerdict(output: string): string {
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].trim().match(VERDICT_RE);
    if (m) {
      const approved = m[1].toUpperCase() === "APPROVED";
      lines[i] = approved
        ? "**Verdict: APPROVED**"
        : `**Verdict: NEEDS REVISION** (${countBlockingFindings(output)} blocking)`;
      break;
    }
  }
  return lines.join("\n").trim();
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/review-contract.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/review-contract.ts src/review-contract.test.ts
git commit -m "feat: review-contract module — marker dedup, verdict parsing, round counting"
```

---

### Task 3: `scrubWorktreePaths` in `src/claude.ts`

**Files:**
- Modify: `src/claude.ts` (add one exported pure function near the worktree helpers)
- Test: `src/claude.test.ts` (append a new `describe` block)

**Interfaces:**
- Produces: `scrubWorktreePaths(text: string, wtPath?: string): string` — Tasks 5 and 6 call it on all AI output before posting to GitHub.

- [ ] **Step 1: Write the failing test**

Append to `src/claude.test.ts` (top-level, alongside the existing describes; it's a pure function so no mocks needed beyond what the file already sets up):

```typescript
describe("scrubWorktreePaths", () => {
  it("strips the exact worktree prefix, leaving repo-relative paths", () => {
    const wt = "/home/debian/.yeti/worktrees/frostyard/updex/plan-reviewer/yeti/review-84-ab12";
    const text = `See [updex/install.go](${wt}/updex/install.go#L36) and ${wt}/config/transfer.go:152.`;
    expect(scrubWorktreePaths(text, wt)).toBe(
      "See [updex/install.go](updex/install.go#L36) and config/transfer.go:152.",
    );
  });

  it("defensively strips other users' worktree path variants without wtPath", () => {
    const text = "link: /home/yeti/.yeti/worktrees/frostyard/updex/plan-reviewer/yeti/review-84-4dc7/updex/install.go";
    expect(scrubWorktreePaths(text)).toBe("link: updex/install.go");
  });

  it("returns text unchanged when nothing matches", () => {
    expect(scrubWorktreePaths("plain text, src/api.ts:12")).toBe("plain text, src/api.ts:12");
  });
});
```

Add `scrubWorktreePaths` to the existing import from `./claude.js` at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/claude.test.ts -t scrubWorktreePaths`
Expected: FAIL — `scrubWorktreePaths` is not exported.

- [ ] **Step 3: Implement**

In `src/claude.ts`, add near the worktree lifecycle functions:

```typescript
/**
 * Strip worktree absolute-path prefixes from AI output before posting to
 * GitHub, so file references are repo-relative instead of dead links.
 * The generic pattern matches ~/.yeti/worktrees/<owner>/<repo>/<job>/<branch...>/
 * where the branch segment is the yeti/<name> pair worktree branches use.
 */
export function scrubWorktreePaths(text: string, wtPath?: string): string {
  let out = text;
  if (wtPath) {
    out = out.replaceAll(wtPath.endsWith("/") ? wtPath : wtPath + "/", "");
  }
  // Defensive: any other run's worktree path (different user/branch).
  out = out.replace(/\/home\/[^/\s]+\/\.yeti\/worktrees\/[^/\s]+\/[^/\s]+\/[^/\s]+\/yeti\/[^/\s]+\//g, "");
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/claude.test.ts -t scrubWorktreePaths`
Expected: PASS. Also run the whole file (`npx vitest run src/claude.test.ts`) to confirm no collateral damage.

- [ ] **Step 5: Commit**

```bash
git add src/claude.ts src/claude.test.ts
git commit -m "feat(claude): scrubWorktreePaths strips worktree prefixes from posted output"
```

---

### Task 4: Rewrite the reviewer policy and prompt builder

**Files:**
- Modify: `src/policies/plan-reviewer.md` (full rewrite)
- Modify: `src/jobs/plan-reviewer.ts:14-33` (`buildReviewPrompt` + new helpers; leave `run`/`processIssue` for Task 5)
- Test: `src/jobs/plan-reviewer.test.ts` (replace `describe("buildReviewPrompt (policy template)")`, lines ~452-510)

**Interfaces:**
- Consumes: `renderPolicy` from `src/policy.ts`, `IssueComment.updatedAt` (Task 1).
- Produces (Task 5 uses these):
  - `buildThreadSection(comments: gh.IssueComment[], planCommentId: number): string`
  - `buildRoundInfo(round: number, maxRounds: number): string`
  - `buildReviewPrompt(autonomy: Autonomy, fullName: string, issue: gh.Issue, planBody: string, threadSection: string, roundInfo: string): string`
- Template variables in the policy: `FULL_NAME`, `ISSUE_NUMBER`, `ISSUE_TITLE`, `ISSUE_BODY`, `PLAN_BODY`, `THREAD_SECTION`, `ROUND_INFO`. `VERDICT_BLOCK` is gone.

- [ ] **Step 1: Write the failing tests**

In `src/jobs/plan-reviewer.test.ts`, delete the entire `describe("buildReviewPrompt (policy template)")` block (the pre-migration behavior-preservation tests — the prompt is intentionally changing) and replace with:

```typescript
describe("prompt building", () => {
  const issue = mockIssue({ number: 42, title: "Add dark mode", body: "Some issue description" });
  const planBody = "## Implementation Plan\n\nDo the thing";

  describe("buildThreadSection", () => {
    it("labels human comments MAINTAINER (binding) and yeti comments as automated", () => {
      const comments = [
        { id: 1, body: "<!-- yeti-automated -->## Plan Review\n\nold review", login: "yeti[bot]", updatedAt: "" },
        { id: 2, body: "please keep the API stable", login: "bsherman", updatedAt: "" },
      ];
      const out = buildThreadSection(comments, 99);
      expect(out).toContain("Comment by @yeti[bot] (automated by Yeti):");
      expect(out).toContain("MAINTAINER (binding) — comment by @bsherman:");
      expect(out).toContain("please keep the API stable");
    });

    it("labels non-yeti bot comments as bot, not maintainer", () => {
      const comments = [{ id: 1, body: "coverage 80%", login: "codecov[bot]", updatedAt: "" }];
      expect(buildThreadSection(comments, 99)).toContain("Comment by @codecov[bot] (bot):");
    });

    it("elides the plan comment itself", () => {
      const comments = [
        { id: 501, body: "<!-- yeti-automated -->## Implementation Plan\n\nthe plan", login: "yeti[bot]", updatedAt: "" },
        { id: 502, body: "a reply", login: "bsherman", updatedAt: "" },
      ];
      const out = buildThreadSection(comments, 501);
      expect(out).not.toContain("the plan");
      expect(out).toContain("a reply");
    });

    it("says so when there are no other comments", () => {
      expect(buildThreadSection([], 501)).toContain("No other comments");
    });
  });

  describe("buildRoundInfo", () => {
    it("states the round position", () => {
      expect(buildRoundInfo(1, 3)).toBe("This is review round 1 of 3.");
    });

    it("adds the final-round instruction at max rounds", () => {
      const out = buildRoundInfo(3, 3);
      expect(out).toContain("round 3 of 3");
      expect(out).toContain("final round");
      expect(out).toContain("do not manufacture findings");
    });
  });

  describe("buildReviewPrompt", () => {
    it("renders issue, plan, thread, round info, and the contract", () => {
      const out = stripPreamble(
        buildReviewPrompt("pr", "acme/widget", issue, planBody, "THREAD-CONTENT", "This is review round 2 of 3."),
      );
      expect(out).toContain("acme/widget#42");
      expect(out).toContain("Add dark mode");
      expect(out).toContain("Some issue description");
      expect(out).toContain(planBody);
      expect(out).toContain("THREAD-CONTENT");
      expect(out).toContain("This is review round 2 of 3.");
      // Contract essentials
      expect(out).toContain("MAINTAINER comments are binding");
      expect(out).toContain("Blocking");
      expect(out).toContain("Advisory");
      expect(out).toContain("VERDICT: APPROVED");
      expect(out).toContain("VERDICT: NEEDS REVISION");
      expect(out).toContain("repo-relative");
    });

    it("always includes the verdict instruction (no reviewLoop parameter)", () => {
      const out = buildReviewPrompt("pr", "acme/widget", issue, planBody, "(No other comments on the issue.)", "This is review round 1 of 3.");
      expect(out).toContain("VERDICT:");
    });
  });
});
```

Update the import at line 82 to: `import { run, buildReviewPrompt, buildThreadSection, buildRoundInfo } from "./plan-reviewer.js";`

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/jobs/plan-reviewer.test.ts -t "prompt building"`
Expected: FAIL — `buildThreadSection`/`buildRoundInfo` not exported; prompt lacks new content. (Other tests in the file will also fail until Task 5 — that's expected; only gate on this describe for now.)

- [ ] **Step 3: Rewrite the policy file**

Replace the full contents of `src/policies/plan-reviewer.md` with:

```markdown
You are adversarially reviewing an implementation plan for ${FULL_NAME}#${ISSUE_NUMBER}.
${ROUND_INFO} Your verdict gates whether this plan proceeds to implementation.

**Issue: ${ISSUE_TITLE}**

${ISSUE_BODY}

## Discussion thread

Comments on the issue so far, in order. Comments labeled MAINTAINER (binding)
are decisions by a human maintainer.

${THREAD_SECTION}

## The plan under review

${PLAN_BODY}

## Ground rules

1. MAINTAINER comments are binding decisions. Never re-raise anything a
   maintainer has settled. If the plan follows a maintainer instruction, that
   choice is correct by definition — review the execution, not the decision.
2. The plan's stated assumptions and any "Clarifying Questions (non-blocking)"
   section are its declared contract. Do not flag them as defects — the human
   answers them. You may contradict a stated assumption only as a Blocking
   finding backed by evidence from the issue text or the thread.
3. Verify before you assert. Every Blocking finding must cite a file you
   actually opened in this session, referenced as a repo-relative path:line
   (for example `src/install.go:36`). Never use absolute filesystem paths.
   If you cannot ground a suspicion in code you read, it is Advisory at most.
4. Closure before novelty. If the thread contains a previous Plan Review,
   first disposition each of its findings: resolved, not resolved, or settled
   (overtaken by a maintainer decision or a declined-with-evidence response).
   Only then raise new findings. Each NEW Blocking finding in round 2 or later
   must say in one clause why it was not visible in the previous round
   (introduced by the latest revision, or newly verified against the code).
5. Do not expand scope. Work the issue does not require is Advisory at most.
6. A finding must state a failure: what breaks, which explicit requirement is
   violated, or which claim about the codebase is false. "Could be more
   robust" is not a finding.

## Severity

**Blocking** — implementing the plan exactly as written would: fail an
explicit requirement of the issue; break existing behavior, the build, or
tests; rest on a claim about the codebase that is factually wrong (you read
the file and it says otherwise); or contradict an explicit maintainer
decision in the thread. Nothing else is Blocking.

**Advisory** — everything else: test-coverage suggestions, documentation
completeness, risk framing, style, "consider also". Advisory findings never
gate approval.

## Verdict rule

Zero Blocking findings → APPROVED (open Advisory findings are fine).
One or more Blocking findings → NEEDS REVISION. No other criteria.

## Output format

Produce exactly this structure (omit "Prior findings" in round 1; omit an
empty Blocking or Advisory section):

### Prior findings
- R1-B1: resolved — <one clause>
- R1-B2: not resolved — <what is still missing>
- R1-A1: settled — <maintainer decision or accepted decline>

### Blocking
- [R${ROUND_NUMBER}-B1] <one-sentence defect: what breaks or which requirement is violated> (path/to/file.ext:123)

### Advisory
- [R${ROUND_NUMBER}-A1] <one-sentence suggestion>

End your review with exactly one of these lines on its own line:
VERDICT: APPROVED
VERDICT: NEEDS REVISION

Do not include both.

Read yeti/OVERVIEW.md if it exists for codebase context before reviewing.
Do NOT make code changes. Only produce your review as text output.
```

- [ ] **Step 4: Rewrite the prompt builders in `src/jobs/plan-reviewer.ts`**

Replace `buildReviewPrompt` (lines 14-33) with the three functions below. Also delete the local `REVIEW_HEADER` constant (line 12), `parseVerdict` (lines 35-43), and `stripVerdictLine` (lines 45-58), and `countPlanRounds` (lines 60-64) — Task 5 switches `processIssue`/`run` to the `review-contract.js` equivalents; to keep the file compiling between tasks, add the import now:

```typescript
import {
  REVIEW_HEADER,
  reviewMarker,
  findReviewOfPlanVersion,
  parseVerdict,
  renderVerdict,
  countPlanRounds,
} from "../review-contract.js";
```

```typescript
export function buildThreadSection(comments: gh.IssueComment[], planCommentId: number): string {
  const rest = comments.filter((c) => c.id !== planCommentId);
  if (rest.length === 0) return "(No other comments on the issue.)";
  return rest
    .map((c) => {
      const label = gh.isYetiComment(c.body)
        ? `Comment by @${c.login} (automated by Yeti):`
        : c.login.endsWith("[bot]")
          ? `Comment by @${c.login} (bot):`
          : `MAINTAINER (binding) — comment by @${c.login}:`;
      return ["---", label, gh.stripYetiMarker(c.body), ""].join("\n");
    })
    .join("\n");
}

export function buildRoundInfo(round: number, maxRounds: number): string {
  const base = `This is review round ${round} of ${maxRounds}.`;
  if (round >= maxRounds) {
    return `${base} This is the final round: if nothing rises to Blocking, approve — do not manufacture findings.`;
  }
  return base;
}

export function buildReviewPrompt(
  autonomy: Autonomy,
  fullName: string,
  issue: gh.Issue,
  planBody: string,
  threadSection: string,
  roundInfo: string,
): string {
  const roundNumber = roundInfo.match(/round (\d+)/)?.[1] ?? "1";
  return renderPolicy("plan-reviewer", autonomy, {
    FULL_NAME: fullName,
    ISSUE_NUMBER: String(issue.number),
    ISSUE_TITLE: issue.title,
    ISSUE_BODY: issue.body || "(No description provided)",
    PLAN_BODY: planBody,
    THREAD_SECTION: threadSection,
    ROUND_INFO: roundInfo,
    ROUND_NUMBER: roundNumber,
  });
}
```

Interim compile fix inside `processIssue` (fully rewired in Task 5): change the `buildReviewPrompt(...)` call to

```typescript
    const round = countPlanRounds(comments) + 1;
    const prompt = buildReviewPrompt(
      repoAutonomy(repo), fullName, issue, planComment.body,
      buildThreadSection(comments, planComment.id),
      buildRoundInfo(round, MAX_PLAN_ROUNDS),
    );
```

and change `const commentBody = REVIEW_LOOP ? stripVerdictLine(reviewOutput) : reviewOutput;` to `const commentBody = renderVerdict(reviewOutput);`, and in the verdict branch replace `parseVerdict(reviewOutput)` handling with:

```typescript
      const parsed = parseVerdict(reviewOutput);
      if (parsed === "missing") {
        log.warn(`[plan-reviewer] No verdict line in review for ${fullName}#${issue.number} — treating as needs-revision`);
      }
      const verdict = parsed === "approved" ? "approved" : "needs-revision";
```

and `const completedRounds = countPlanRounds(comments) + 1;` stays but now uses the imported (human-reset) version.

- [ ] **Step 5: Run the prompt tests to verify they pass**

Run: `npx vitest run src/jobs/plan-reviewer.test.ts -t "prompt building"`
Expected: PASS. Other describes in this file still fail (rewired in Task 5).

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/policies/plan-reviewer.md src/jobs/plan-reviewer.ts src/jobs/plan-reviewer.test.ts
git commit -m "feat(plan-reviewer): contract-based review policy with thread context and round info"
```

---

### Task 5: Rewire plan-reviewer job — marker dedup, always-verdict, scrubbing

**Files:**
- Modify: `src/jobs/plan-reviewer.ts` (`processIssue` posting/labels, `run` dedup)
- Test: `src/jobs/plan-reviewer.test.ts` (update existing describes)

**Interfaces:**
- Consumes: everything produced by Tasks 1-4.
- Produces: posted review body shape `"## Plan Review\n\n<rendered output>\n\n<!-- yeti-review-of:ID:TS -->"` — Task 6's routing depends on the marker being present.

- [ ] **Step 1: Update the existing tests (write failing tests)**

In `src/jobs/plan-reviewer.test.ts`:

a) Everywhere a comments array is built, add `updatedAt`. The shared plan comment becomes:

```typescript
  const planComment = { id: 501, body: planCommentBody, login: "yeti-bot", updatedAt: "2026-07-01T10:00:00Z" };
```

and single-comment mocks become `mockGh.getIssueComments.mockResolvedValue([planComment]);`.

b) The mockGh factory needs two additions (`stripYetiMarker` is used by `buildThreadSection`):

```typescript
    stripYetiMarker: (body: string) => body.replace("<!-- yeti-automated -->", "").trim(),
```

and mockClaude needs:

```typescript
    scrubWorktreePaths: (text: string) => text,
```

c) Replace the reaction-based dedup test (the existing test asserting "skips plans already reviewed" via `getCommentReactions` — search for `alreadyReviewed` or the test using `getCommentReactions.mockResolvedValue([{ user: { login: ... }, content: "+1" }])`) with marker-based tests:

```typescript
  it("skips a plan version that already has a review marker", async () => {
    const issue = mockIssue({ labels: [{ name: "Needs Plan Review" }] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([
      planComment,
      {
        id: 601,
        body: `<!-- yeti-automated -->## Plan Review\n\nold\n\n<!-- yeti-review-of:501:2026-07-01T10:00:00Z -->`,
        login: "someone-else[bot]", // identity-independent: not the current selfLogin
        updatedAt: "",
      },
    ]);

    await run([repo]);

    expect(mockClaude.runAI).not.toHaveBeenCalled();
  });

  it("re-reviews when the plan was edited after the last review (marker mismatch)", async () => {
    const issue = mockIssue({ labels: [{ name: "Needs Plan Review" }] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([
      { ...planComment, updatedAt: "2026-07-02T09:00:00Z" },
      {
        id: 601,
        body: `<!-- yeti-automated -->## Plan Review\n\nold\n\n<!-- yeti-review-of:501:2026-07-01T10:00:00Z -->`,
        login: "yeti-bot",
        updatedAt: "",
      },
    ]);
    mockClaude.runAI.mockResolvedValue("Fresh look.\nVERDICT: APPROVED");

    await run([repo]);

    expect(mockClaude.runAI).toHaveBeenCalled();
  });

  it("posts the review with a marker for the reviewed plan version", async () => {
    const issue = mockIssue({ labels: [{ name: "Needs Plan Review" }] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getIssueComments.mockResolvedValue([planComment]);
    mockClaude.runAI.mockResolvedValue("Fine.\nVERDICT: APPROVED");

    await run([repo]);

    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      issue.number,
      expect.stringContaining("<!-- yeti-review-of:501:2026-07-01T10:00:00Z -->"),
    );
    expect(mockGh.addReaction).not.toHaveBeenCalled();
  });
```

d) In `describe("review loop enabled")`: update `setupIssueWithReview` so prior-review comments include `updatedAt: ""` and, per the new dedup, are *not* markered for the current plan (they represent earlier rounds of older plan versions):

```typescript
        comments.push({
          id: 600 + i,
          body: "<!-- yeti-automated -->## Plan Review\n\nPrior review",
          login: "yeti-bot",
          updatedAt: "",
        });
```

e) Replace the test `"does not add verdict instruction when review loop is disabled"` with:

```typescript
    it("includes the verdict instruction even when review loop is disabled", async () => {
      mockConfig.REVIEW_LOOP = false;
      const issue = mockIssue({ labels: [{ name: "Needs Plan Review" }] });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      mockGh.getIssueComments.mockResolvedValue([planComment]);
      mockClaude.runAI.mockResolvedValue("Fine.\nVERDICT: APPROVED");

      await run([repo]);

      expect(mockClaude.runAI).toHaveBeenCalledWith(
        expect.stringContaining("VERDICT:"),
        "/tmp/worktree",
        { backend: "copilot" },
      );
      // Loop off: labels still go straight to Ready
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Ready");
    });
```

f) Replace `"strips verdict line from posted comment"` with:

```typescript
    it("renders the verdict human-readably in the posted comment", async () => {
      setupIssueWithReview("### Blocking\n- [R1-B1] bad thing (src/x.ts:1)\n\nVERDICT: NEEDS REVISION");

      await run([repo]);

      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        1,
        expect.stringContaining("**Verdict: NEEDS REVISION** (1 blocking)"),
      );
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
        repo.fullName,
        1,
        expect.not.stringMatching(/^VERDICT:/m),
      );
    });
```

g) Add a round-reset test in the same describe:

```typescript
    it("round budget resets after a human comment", async () => {
      mockConfig.MAX_PLAN_ROUNDS = 3;
      const issue = mockIssue({ labels: [{ name: "Needs Plan Review" }] });
      mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
      // 2 old reviews, then a human comment, then the current plan: rounds-in-loop = 0
      mockGh.getIssueComments.mockResolvedValue([
        { id: 601, body: "<!-- yeti-automated -->## Plan Review\n\nold 1", login: "yeti-bot", updatedAt: "" },
        { id: 602, body: "<!-- yeti-automated -->## Plan Review\n\nold 2", login: "yeti-bot", updatedAt: "" },
        { id: 603, body: "human weighs in", login: "bsherman", updatedAt: "" },
        planComment,
      ]);
      mockClaude.runAI.mockResolvedValue("Still broken.\nVERDICT: NEEDS REVISION");

      await run([repo]);

      // Not at max: kicks back to refinement instead of forcing Ready
      expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Needs Refinement");
      expect(mockGh.commentOnIssue).not.toHaveBeenCalledWith(
        repo.fullName,
        issue.number,
        expect.stringContaining("Maximum plan review rounds"),
      );
    });
```

Note: `findPlanComment` uses `findLast`, so `planComment` placed last is still found.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run src/jobs/plan-reviewer.test.ts`
Expected: new/updated tests FAIL (reaction-based dedup still active, raw VERDICT still posted, no marker appended).

- [ ] **Step 3: Rewire `run()` and `processIssue()`**

In `src/jobs/plan-reviewer.ts`:

a) In `run()`, replace the reaction-based dedup block (the `try { const reactions = ... } catch { continue; }` section, currently lines ~165-175) with:

```typescript
        // Skip if this exact plan version already has a review (identity-independent,
        // re-arms automatically when the plan comment is edited in place).
        if (findReviewOfPlanVersion(comments, planComment.id, planComment.updatedAt)) continue;
```

`getSelfLogin()` is no longer needed in `run()` — remove the call and its variable.

b) In `processIssue()`, replace the posting block (currently `const commentBody = ...` through `await gh.addReaction(...)`) with:

```typescript
    const rendered = renderVerdict(stripLearningsDeclaration(reviewOutput));
    const scrubbed = claude.scrubWorktreePaths(rendered, wtPath);
    const marker = reviewMarker(planComment.id, planComment.updatedAt);
    await gh.commentOnIssue(fullName, issue.number, `${REVIEW_HEADER}\n\n${scrubbed}\n\n${marker}`);
    log.info(`[plan-reviewer] Posted review for ${fullName}#${issue.number}`);
    notify({ jobName: "plan-reviewer", message: `Review posted for ${fullName}#${issue.number}`, url: gh.issueUrl(fullName, issue.number) });
```

(the `addReaction` call on the plan comment is deleted.)

c) The verdict/label block keeps its existing structure (REVIEW_LOOP on: approved → Ready; needs-revision under max → Needs Refinement; at max → warning + Ready; REVIEW_LOOP off: always Ready), using the Task 4 interim code (`parseVerdict` from review-contract, `missing` logged). Confirm `completedRounds` computes as `countPlanRounds(comments) + 1` with the imported human-reset version.

d) `log` import: the file already imports `* as log`; the `missing`-verdict warning uses it.

- [ ] **Step 4: Run the full test file to verify it passes**

Run: `npx vitest run src/jobs/plan-reviewer.test.ts`
Expected: PASS (all describes).

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/jobs/plan-reviewer.ts src/jobs/plan-reviewer.test.ts
git commit -m "feat(plan-reviewer): marker-based dedup, human-reset rounds, always-on rendered verdict, path scrubbing"
```

---

### Task 6: Refiner revision path — `issue-refiner.revise.md` + routing

**Files:**
- Create: `src/policies/issue-refiner.revise.md`
- Modify: `src/jobs/issue-refiner.ts` (new `buildReviseFromReviewPrompt`, new `processReviewRevision`, three-way routing in `run()`, `Needs Refinement` removal + scrubbing in `processRefinement`)
- Test: `src/jobs/issue-refiner.test.ts` (new describe + routing updates)

**Interfaces:**
- Consumes: `findReviewOfPlanVersion` (Task 2), `scrubWorktreePaths` (Task 3), `IssueComment.updatedAt` (Task 1).
- Produces: revised plan via `editIssueComment` on the existing plan comment; separate `### Review Response` comment; labels `Needs Refinement` → removed, `Needs Plan Review` → added when actionable.

- [ ] **Step 1: Write the failing tests**

In `src/jobs/issue-refiner.test.ts`, mirror the existing mock setup (the file already mocks `../github.js`, `../claude.js`, `../db.js`, `../config.js` the same way plan-reviewer.test.ts does — reuse its existing hoisted mocks). Ensure `mockClaude` includes `scrubWorktreePaths: (text: string) => text` and `mockGh` includes `editIssueComment: vi.fn()` (check the existing hoisted object first; add only what's missing). Add a new describe:

```typescript
describe("review-revision routing", () => {
  const planComment = {
    id: 501,
    body: "<!-- yeti-automated -->## Implementation Plan\n\nOriginal plan",
    login: "yeti-bot",
    updatedAt: "2026-07-01T10:00:00Z",
  };
  const reviewComment = {
    id: 601,
    body: "<!-- yeti-automated -->## Plan Review\n\n### Blocking\n- [R1-B1] bad (src/a.ts:1)\n\n**Verdict: NEEDS REVISION** (1 blocking)\n\n<!-- yeti-review-of:501:2026-07-01T10:00:00Z -->",
    login: "yeti-bot",
    updatedAt: "",
  };

  function setupKickedBackIssue(comments: unknown[]) {
    const issue = mockIssue({ labels: [{ name: "Needs Refinement" }] });
    mockGh.listOpenIssues.mockResolvedValueOnce([issue]);
    mockGh.getOpenPRForIssue.mockResolvedValue(null);
    mockGh.getIssueComments.mockResolvedValue(comments);
    mockGh.getCommentReactions.mockResolvedValue([]);
    return issue;
  }

  it("routes reviewer kickback to a review revision that edits the plan in place", async () => {
    const issue = setupKickedBackIssue([planComment, reviewComment]);
    mockClaude.runAI.mockResolvedValue(
      "## Updated plan\n\nBetter plan\n\n### Review Response\n- R1-B1: accepted — added the guard",
    );

    await run([repo]);

    // Edits the existing plan comment rather than posting a new plan
    expect(mockGh.editIssueComment).toHaveBeenCalledWith(
      repo.fullName,
      501,
      expect.stringContaining("Better plan"),
    );
    // Review Response is split into its own comment
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      issue.number,
      expect.stringContaining("### Review Response"),
    );
    // Plan body posted does NOT contain the response section
    expect(mockGh.editIssueComment).toHaveBeenCalledWith(
      repo.fullName,
      501,
      expect.not.stringContaining("### Review Response"),
    );
    // Re-arms the reviewer
    expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Needs Refinement");
    expect(mockGh.addLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Needs Plan Review");
    // Prompt uses the revise policy: carries the review body and the finding ID
    expect(mockClaude.runAI).toHaveBeenCalledWith(
      expect.stringContaining("[R1-B1]"),
      expect.any(String),
      expect.anything(),
    );
  });

  it("prefers human feedback over the review kickback and absorbs the review into the same revision", async () => {
    const humanComment = { id: 700, body: "actually, keep the old name", login: "bsherman", updatedAt: "" };
    setupKickedBackIssue([planComment, reviewComment, humanComment]);
    mockClaude.runAI.mockResolvedValue("## Updated plan\n\nCombined revision");

    await run([repo]);

    // Human path: refinement prompt contains BOTH the human comment and the review
    const prompt = mockClaude.runAI.mock.calls[0][0] as string;
    expect(prompt).toContain("keep the old name");
    expect(prompt).toContain("[R1-B1]");
  });

  it("falls back to a fresh replan when the label is set but no review matches the current plan version", async () => {
    // Plan was edited after the review — marker is stale, and no human comments
    setupKickedBackIssue([{ ...planComment, updatedAt: "2026-07-02T09:00:00Z" }, reviewComment]);
    mockClaude.runAI.mockResolvedValue("## Implementation Plan\n\nFresh plan");

    await run([repo]);

    // Fresh replan posts a NEW plan comment (does not edit in place)
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      repo.fullName,
      1,
      expect.stringContaining("Fresh plan"),
    );
    expect(mockGh.editIssueComment).not.toHaveBeenCalled();
  });

  it("waits for human input when the revision has blocking clarifying questions", async () => {
    const issue = setupKickedBackIssue([planComment, reviewComment]);
    mockClaude.runAI.mockResolvedValue(
      "### Clarifying Questions (blocking)\n1. Which behavior do you want?",
    );

    await run([repo]);

    expect(mockGh.removeLabel).toHaveBeenCalledWith(repo.fullName, issue.number, "Needs Refinement");
    expect(mockGh.addLabel).not.toHaveBeenCalledWith(repo.fullName, issue.number, "Needs Plan Review");
  });
});
```

Adapt setup-helper names to the file's existing conventions if they differ (e.g., how `resolveEnqueue` is primed in its `beforeEach`) — copy the file's own `beforeEach` priming for `mockClaude`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/jobs/issue-refiner.test.ts -t "review-revision routing"`
Expected: FAIL — routing still sends every labeled issue to a fresh replan; `processReviewRevision` doesn't exist.

- [ ] **Step 3: Create the revise policy**

Create `src/policies/issue-refiner.revise.md`:

```markdown
You are revising an implementation plan for ${FULL_NAME}#${ISSUE_NUMBER} in
response to an adversarial plan review.

**Issue: ${ISSUE_TITLE}**

${ISSUE_BODY}

## Current plan

${EXISTING_PLAN}

## Review to address

${REVIEW_BODY}

If `yeti/OVERVIEW.md` exists in the repository, read it first (and any linked
documents that seem relevant) for context about the codebase architecture and
patterns.

Before revising, read every source file the review's findings reference and
every file whose plan section you intend to change. Do not accept or decline
a finding without reading the code it points at.

## Addressing findings

Process every finding by its ID (for example R2-B1, R2-A3):

- **Blocking findings** must each be either **accepted** (revise the plan;
  say what changed) or **declined** (give a concrete technical reason grounded
  in code you read — "not necessary" is not a reason). Never silently drop one.
- **Advisory findings** may be adopted or declined freely; still list each
  disposition in one line.

If a finding is ambiguous, or two findings conflict, do not guess: put the
question in a `### Clarifying Questions (blocking)` section and stop there
(output only the questions, no revised plan). If the question is merely a
preference check, use `### Clarifying Questions (non-blocking)` and proceed.

## Revision rules

Make targeted edits to the current plan. Preserve every section the findings
do not touch, verbatim. Do not restructure, re-derive, or rewrite the plan
from scratch — the reviewer will re-read it and unnecessary churn creates new
review surface. Stay within the scope of the original issue; work a finding
suggests beyond that scope goes to a `### Out of Scope` note, not the plan.

## Output format

Output the full updated plan first (same structure as the current plan: files
to change, implementation order, risks and edge cases, testing approach).

Then end with exactly one section:

### Review Response
- R2-B1: accepted — <one line: what changed in the plan>
- R2-B2: declined — <one line: concrete technical reason>
- R2-A1: adopted — <one line>

Do NOT make any code changes. Only produce text output.
```

- [ ] **Step 4: Implement `buildReviseFromReviewPrompt` and `processReviewRevision`**

In `src/jobs/issue-refiner.ts`:

a) Add imports:

```typescript
import { findReviewOfPlanVersion } from "../review-contract.js";
```

b) Add the prompt builder next to `buildRefinementPrompt`:

```typescript
export function buildReviseFromReviewPrompt(
  autonomy: Autonomy,
  fullName: string,
  issue: gh.Issue,
  existingPlan: string,
  reviewBody: string,
): string {
  return renderPolicy("issue-refiner.revise", autonomy, {
    FULL_NAME: fullName,
    ISSUE_NUMBER: String(issue.number),
    ISSUE_TITLE: issue.title,
    ISSUE_BODY: issue.body || "(No description provided)",
    EXISTING_PLAN: existingPlan,
    REVIEW_BODY: reviewBody,
  });
}
```

c) Add `processReviewRevision` after `processRefinement`:

```typescript
async function processReviewRevision(
  repo: Repo,
  issue: gh.Issue,
  planComment: gh.IssueComment,
  reviewComment: gh.IssueComment,
): Promise<void> {
  const fullName = repo.fullName;
  log.info(`[issue-refiner] Revising plan from review for ${fullName}#${issue.number}: ${issue.title}`);

  const taskId = db.recordTaskStart("issue-refiner", fullName, issue.number, null);
  let wtPath: string | undefined;
  const aiOptions = JOB_AI["issue-refiner"];

  try {
    const branchName = `yeti/plan-${issue.number}-${claude.randomSuffix()}`;
    wtPath = await claude.createWorktree(repo, branchName, "issue-refiner");
    db.updateTaskWorktree(taskId, wtPath, branchName);

    const prompt = buildReviseFromReviewPrompt(
      repoAutonomy(repo), fullName, issue,
      gh.stripYetiMarker(planComment.body), gh.stripYetiMarker(reviewComment.body),
    );
    const planOutput = await claude.resolveEnqueue(aiOptions)(
      () => claude.runAI(prompt, wtPath!, aiOptions),
      gh.hasPriorityLabel(issue.labels),
    );

    if (!planOutput.trim()) {
      log.warn(`[issue-refiner] Empty revision output for ${fullName}#${issue.number}`);
      db.recordTaskFailed(taskId, "Empty revision output");
      return;
    }

    // Split the Review Response into its own comment so the plan stays clean.
    const respMatch = planOutput.match(/### Review Response\s*\n([\s\S]*)$/);
    const planBody = respMatch ? planOutput.slice(0, respMatch.index).trim() : planOutput;

    const actionable = isPlanActionable(planOutput);
    if (actionable) {
      const scrubbedPlan = claude.scrubWorktreePaths(stripLearningsDeclaration(planBody), wtPath);
      await gh.editIssueComment(fullName, planComment.id, `${PLAN_HEADER}\n\n${scrubbedPlan}`);
      log.info(`[issue-refiner] Revised plan comment for ${fullName}#${issue.number}`);
      notify({ jobName: "issue-refiner", message: `Plan revised after review for ${fullName}#${issue.number}`, url: gh.issueUrl(fullName, issue.number) });
    }
    if (respMatch) {
      const scrubbedResp = claude.scrubWorktreePaths(stripLearningsDeclaration(respMatch[1].trim()), wtPath);
      await gh.commentOnIssue(fullName, issue.number, `### Review Response\n${scrubbedResp}`);
    }
    if (!actionable && !respMatch) {
      // Blocking clarifying questions with no response section: post them so the human sees them.
      await gh.commentOnIssue(fullName, issue.number, claude.scrubWorktreePaths(stripLearningsDeclaration(planOutput), wtPath));
    }

    await gh.removeLabel(fullName, issue.number, LABELS.needsRefinement);
    if (actionable) {
      await gh.addLabel(fullName, issue.number, LABELS.needsPlanReview);
    }
    // Not actionable: no label — issue waits for human answers.

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
```

d) Replace the `else if (issue.labels.some((l) => l.name === LABELS.needsRefinement))` branch in `run()` (currently lines ~394-401) with the three-way routing:

```typescript
        } else if (issue.labels.some((l) => l.name === LABELS.needsRefinement)) {
          const planComment = comments[lastPlanIdx];
          const commentsAfterPlan = comments.slice(lastPlanIdx + 1);
          const unreactedComments = await findUnreactedHumanComments(repo.fullName, commentsAfterPlan, selfLogin);
          const review = findReviewOfPlanVersion(comments, planComment.id, planComment.updatedAt);

          gh.populateQueueCache("needs-refinement", repo.fullName, { number: issue.number, title: issue.title, type: "issue", updatedAt: issue.updatedAt, priority: gh.hasPriorityLabel(issue.labels) });

          if (unreactedComments.length > 0) {
            // Human feedback outranks the loop; absorb a pending review into the same revision.
            const feedback = review ? [review, ...unreactedComments] : unreactedComments;
            tasks.push(
              processRefinement(repo, issue, feedback).catch((err) =>
                reportError("issue-refiner:process-refinement", `${repo.fullName}#${issue.number}`, err),
              ),
            );
          } else if (review) {
            // Reviewer kicked the plan back: targeted revision, not a replan.
            tasks.push(
              processReviewRevision(repo, issue, planComment, review).catch((err) =>
                reportError("issue-refiner:process-review-revision", `${repo.fullName}#${issue.number}`, err),
              ),
            );
          } else {
            // Human re-added the label with no new input — deliberate "start over".
            tasks.push(
              processIssue(repo, issue).catch((err) =>
                reportError("issue-refiner:process-issue", `${repo.fullName}#${issue.number}`, err),
              ),
            );
          }
        }
```

e) In `processRefinement`, after the `addLabel(LABELS.needsPlanReview)` block (lines ~229-236), add label cleanup so the human-feedback path also clears a reviewer kickback:

```typescript
    await gh.removeLabel(fullName, issue.number, LABELS.needsRefinement);
```

and wrap its posted bodies with scrubbing: change `stripLearningsDeclaration(planBody)` to `claude.scrubWorktreePaths(stripLearningsDeclaration(planBody), wtPath)` in the `editIssueComment` call, the `### Note` `commentOnIssue` call, and in `processIssue`'s `commentOnIssue` call (`stripLearningsDeclaration(planOutput)` → `claude.scrubWorktreePaths(stripLearningsDeclaration(planOutput), wtPath)`).

Note: `processRefinement` reacts 👍 to every comment in the array it was given — including the review comment when absorbed. Harmless, and routing self-disarms anyway because the plan edit changes `updatedAt`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/jobs/issue-refiner.test.ts`
Expected: PASS — the new describe and all pre-existing tests (existing routing tests for the label path may need `getIssueComments` mocks to include no review comment so they still hit the fresh-replan branch; adjust their comment fixtures with `updatedAt: ""` where TS/behavior requires).

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: clean.

```bash
git add src/policies/issue-refiner.revise.md src/jobs/issue-refiner.ts src/jobs/issue-refiner.test.ts
git commit -m "feat(issue-refiner): targeted review-revision path with Review Response contract"
```

---

### Task 7: Documentation

**Files:**
- Modify: `CLAUDE.md` (Jobs paragraph about the review loop)
- Modify: `yeti/OVERVIEW.md` (label flow ~lines 129-145, config table lines 457-458, module list line 47)
- Modify: `yeti/jobs.md` (plan-reviewer section ~line 121, issue-refiner sections ~lines 67/92, lifecycle at ~line 145)
- Modify: `yeti/modules.md` (~line 229 plan-parser entry; add review-contract entry)

**Interfaces:** none (docs only). Written for AI consumption per the `yeti/` convention.

- [ ] **Step 1: Update `CLAUDE.md`**

In the Jobs section paragraph beginning "When plan-reviewer is enabled…", rewrite the `reviewLoop` sentence to describe the new mechanics. Replace:

> When `reviewLoop` is enabled in config, plan-reviewer can send plans back to issue-refiner for automatic re-refinement (up to `maxPlanRounds` cycles, default 3) before falling through to human review.

with:

> When `reviewLoop` is enabled in config, the loop converges autonomously: plan-reviewer reviews with full thread context under a Blocking/Advisory contract (`src/review-contract.ts` — verdict is mechanical: zero Blocking findings → APPROVED). NEEDS REVISION kicks the issue back with `Needs Refinement`; issue-refiner routes reviewer kickbacks to a targeted revision (`issue-refiner.revise.md` — findings dispositioned by ID, plan edited in place, `### Review Response` posted separately) rather than a from-scratch replan. Review dedup is a `<!-- yeti-review-of:id:updatedAt -->` marker (identity-independent, re-arms on plan edits). Round budget (`maxPlanRounds`, default 3) counts reviews since the last human comment; at the cap the issue falls through to `Ready` for human review. Human feedback always outranks the loop and resets the round budget.

- [ ] **Step 2: Update `yeti/OVERVIEW.md`**

- Module tree (line ~47): keep the `plan-reviewer.ts` line, update its description to "Adversarial plan review with thread context; Blocking/Advisory verdict contract".
- Add `review-contract.ts` to the `src/` module tree with: "Shared review protocol: review marker dedup, verdict parse/render, round counting (used by plan-reviewer and issue-refiner)".
- Label-flow diagram (~lines 137-145): note that with `reviewLoop` on, `NEEDS REVISION → Needs Refinement → (issue-refiner revises plan in place) → Needs Plan Review → …` until `APPROVED → Ready`, max `maxPlanRounds` rounds since last human comment.
- Config table rows for `reviewLoop`/`maxPlanRounds` (~457-458): update descriptions to mention the convergent contract and human-comment round reset.

- [ ] **Step 3: Update `yeti/jobs.md`**

- `plan-reviewer` section: document the new prompt inputs (full thread with `MAINTAINER (binding)` labeling, round info), the Blocking/Advisory contract, marker-based dedup replacing reactions, always-on verdict (rendered `**Verdict: …**` in the posted comment), and path scrubbing.
- `issue-refiner` section: document the three-way `Needs Refinement` routing (human feedback → `processRefinement` absorbing any pending review; reviewer kickback → `processReviewRevision` editing the plan in place + `### Review Response` comment; label-only → fresh replan escape hatch) and the new `issue-refiner.revise.md` policy.
- Lifecycle description (~line 145): update to the convergent-loop sequence.

- [ ] **Step 4: Update `yeti/modules.md`**

Add an entry for `review-contract.ts` alongside the `plan-parser.ts` entry (~line 229), listing its exports and which jobs consume them, and note that `IssueComment` now carries `updatedAt`.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md yeti/OVERVIEW.md yeti/jobs.md yeti/modules.md
git commit -m "docs: convergent plan-review loop — contract, routing, marker dedup"
```

---

### Task 8: Full verification

**Files:** none new.

- [ ] **Step 1: Full test + typecheck gate (mirrors CI)**

Run: `npm test`
Expected: typecheck (daemon + web) clean; all vitest projects pass.

- [ ] **Step 2: Build sanity — policies land in dist**

Run: `npm run build:server && ls dist/policies/issue-refiner.revise.md dist/policies/plan-reviewer.md`
Expected: both files listed.

- [ ] **Step 3: Manual prompt replay against the #84 evidence (spot check, not automated)**

Render the new reviewer prompt with real inputs to eyeball the contract working:

```bash
node --input-type=module -e "
import { buildReviewPrompt, buildThreadSection, buildRoundInfo } from './dist/jobs/plan-reviewer.js';
const issue = { number: 84, title: 'Drop redundant staging dir symlink', body: 'CurrentSymlink should be optional...', labels: [] };
const comments = [
  { id: 1, body: 'It is acceptable to remove UpdateSymlink despite it being a public API given the API is new.', login: 'bsherman', updatedAt: '' },
];
console.log(buildReviewPrompt('pr', 'frostyard/updex', issue, '## Implementation Plan\\n\\nRemove UpdateSymlink...', buildThreadSection(comments, 99), buildRoundInfo(2, 3)));
"
```

Expected: prompt shows `MAINTAINER (binding) — comment by @bsherman:` before the UpdateSymlink approval, the ground rule forbidding re-raising it, round 2 of 3, and the verdict instruction.

- [ ] **Step 4: Quality-check pass (per user's global CLAUDE.md)**

- `git status` — no unexpected deleted/overwritten files; only the files this plan names.
- `git log --oneline main..HEAD` — commits present for tasks 1-7 plus the spec.

- [ ] **Step 5: Final commit if verification produced fixes; otherwise done**

Branch is ready for PR. **Do not create the PR without confirming the target branch with the user** (repo default is `main`). After merge + release, rollout per spec: set `reviewLoop: true` on selfie:yeti, unpause `issue-refiner`/`plan-reviewer`, and exercise a sandbox issue end-to-end.
