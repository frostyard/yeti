# Self-Improvement Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every AI work session produces two outputs — the work and the learning — enforced mechanically: agents declare learnings in output, yeti parses/verifies them, persists environment learnings, and a consolidator job PRs them into policies.

**Architecture:** A pure parser + gate module (`src/learnings.ts`) sits after `runAI` in work jobs. Repo learnings are files the agent commits under the target repo's `yeti/` dir (verified via tree-diff). Environment learnings go into a new `learnings` SQLite table, surfaced in the dashboard, and periodically folded into `src/policies/` by a new `learning-consolidator` job that opens a human-reviewed PR on SELF_REPO.

**Tech Stack:** Node.js 22, ESM, strict TypeScript, better-sqlite3, vitest (heavy `vi.mock` of module boundaries), React + Vite SPA (`web/`), TanStack Query.

**Spec:** `.superpowers/specs/2026-07-02-self-improvement-loop-design.md`

## Global Constraints

- Work on the existing branch `feat/self-improvement-loop`.
- TDD: write the failing test first for every code change; run it, watch it fail, implement, watch it pass.
- Declaration line prefixes are exactly `LEARNINGS-REPO:` and `LEARNINGS-YETI:` (one per line, `none` when empty).
- The gate NEVER fails a task — after one retry, everything is log-and-continue.
- Consolidator pending-count trigger threshold: configurable `learningsPendingThreshold`, default **5**. Daily schedule hour: `learningConsolidatorHour`, default **6**.
- Deviation from spec table (approved during planning): `learnings` gets a nullable `reason` column so "dismissed with a reason" is actually stored.
- All imports use `.js` extensions (ESM).
- Run single test files with `npx vitest run <path>`; full suite is `npm test` (typechecks daemon + web, then all tests).
- Per repo CLAUDE.md cross-cutting rules: config changes touch `deploy/install.sh`, `buildConfigUpdate()` in `src/api.ts`, and `web/src/routes/Config.tsx`; new API routes touch `web/src/lib/api.ts`, `types.ts`, `queries.ts`; docs updates are part of done.

---

### Task 1: `learnings` table + CRUD in db.ts

**Files:**
- Modify: `src/db.ts` (table creation in `initDb()` after the `notifications` block ~line 73; CRUD functions before `_rawDb`)
- Test: `src/db.test.ts` (append a new `describe` block)

**Interfaces:**
- Produces (later tasks rely on these exact signatures):
  - `type LearningKind = "repo" | "yeti"`
  - `interface LearningRow { id: number; job_name: string; repo: string; kind: string; summary: string; status: string; reason: string | null; pr_number: number | null; created_at: string; }`
  - `insertLearning(jobName: string, repo: string, kind: LearningKind, summary: string): number` — dedups against identical pending `(kind, summary)`, returning the existing id
  - `getLearnings(status?: string, limit = 100): LearningRow[]` (newest first)
  - `getPendingLearnings(kind: LearningKind): LearningRow[]` (oldest first)
  - `countPendingLearnings(kind?: LearningKind): number`
  - `markLearningsConsolidated(ids: number[], prNumber: number): void`
  - `dismissLearning(id: number, reason?: string): void`

- [ ] **Step 1: Write the failing tests**

Append to `src/db.test.ts` (inside the file's top-level describe structure, following its existing `beforeEach` that calls `initDb()` on `:memory:`; add the new function names to the existing import list from `./db.js`):

```ts
describe("learnings", () => {
  it("inserts and reads back a pending learning", () => {
    const id = insertLearning("issue-worker", "org/repo", "yeti", "use brew not apt");
    const rows = getLearnings();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id, job_name: "issue-worker", repo: "org/repo", kind: "yeti",
      summary: "use brew not apt", status: "pending", reason: null, pr_number: null,
    });
  });

  it("dedups identical pending summaries of the same kind", () => {
    const a = insertLearning("issue-worker", "org/repo", "yeti", "use brew");
    const b = insertLearning("ci-fixer", "org/other", "yeti", "use brew");
    expect(b).toBe(a);
    expect(getLearnings()).toHaveLength(1);
  });

  it("does not dedup against consolidated learnings", () => {
    const a = insertLearning("issue-worker", "org/repo", "yeti", "use brew");
    markLearningsConsolidated([a], 42);
    const b = insertLearning("issue-worker", "org/repo", "yeti", "use brew");
    expect(b).not.toBe(a);
  });

  it("filters by status and counts pending by kind", () => {
    insertLearning("issue-worker", "org/repo", "yeti", "learning one");
    const two = insertLearning("issue-worker", "org/repo", "yeti", "learning two");
    insertLearning("issue-worker", "org/repo", "repo", "repo learning");
    dismissLearning(two, "already covered");
    expect(countPendingLearnings()).toBe(2);
    expect(countPendingLearnings("yeti")).toBe(1);
    expect(getPendingLearnings("yeti")).toHaveLength(1);
    expect(getLearnings("dismissed")).toHaveLength(1);
    expect(getLearnings("dismissed")[0].reason).toBe("already covered");
  });

  it("marks learnings consolidated with the PR number", () => {
    const a = insertLearning("issue-worker", "org/repo", "yeti", "one");
    const b = insertLearning("issue-worker", "org/repo", "yeti", "two");
    markLearningsConsolidated([a, b], 123);
    const rows = getLearnings("consolidated");
    expect(rows).toHaveLength(2);
    expect(rows[0].pr_number).toBe(123);
    expect(countPendingLearnings()).toBe(0);
  });

  it("markLearningsConsolidated with empty ids is a no-op", () => {
    insertLearning("issue-worker", "org/repo", "yeti", "one");
    markLearningsConsolidated([], 99);
    expect(countPendingLearnings()).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/db.test.ts`
Expected: FAIL — `insertLearning` is not exported / not defined.

- [ ] **Step 3: Implement**

In `src/db.ts`, inside `initDb()` after the `notifications` `db.exec` block:

```ts
  db.exec(`
    CREATE TABLE IF NOT EXISTS learnings (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      job_name   TEXT NOT NULL,
      repo       TEXT NOT NULL,
      kind       TEXT NOT NULL,
      summary    TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'pending',
      reason     TEXT,
      pr_number  INTEGER,
      created_at TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_learnings_status ON learnings(status)`);
```

Before `_rawDb()` add a `// ── Learnings ──` section:

```ts
export type LearningKind = "repo" | "yeti";

export interface LearningRow {
  id: number;
  job_name: string;
  repo: string;
  kind: string;
  summary: string;
  status: string;
  reason: string | null;
  pr_number: number | null;
  created_at: string;
}

export function insertLearning(
  jobName: string,
  repo: string,
  kind: LearningKind,
  summary: string,
): number {
  const d = getDb();
  const dup = d
    .prepare(`SELECT id FROM learnings WHERE kind = ? AND summary = ? AND status = 'pending' LIMIT 1`)
    .get(kind, summary) as { id: number } | undefined;
  if (dup) return dup.id;
  const result = d
    .prepare(`INSERT INTO learnings (job_name, repo, kind, summary, status, created_at) VALUES (?, ?, ?, ?, 'pending', datetime('now'))`)
    .run(jobName, repo, kind, summary);
  return Number(result.lastInsertRowid);
}

export function getLearnings(status?: string, limit = 100): LearningRow[] {
  if (status) {
    return getDb()
      .prepare(`SELECT * FROM learnings WHERE status = ? ORDER BY id DESC LIMIT ?`)
      .all(status, limit) as LearningRow[];
  }
  return getDb()
    .prepare(`SELECT * FROM learnings ORDER BY id DESC LIMIT ?`)
    .all(limit) as LearningRow[];
}

export function getPendingLearnings(kind: LearningKind): LearningRow[] {
  return getDb()
    .prepare(`SELECT * FROM learnings WHERE status = 'pending' AND kind = ? ORDER BY id ASC`)
    .all(kind) as LearningRow[];
}

export function countPendingLearnings(kind?: LearningKind): number {
  const row = kind
    ? getDb().prepare(`SELECT COUNT(*) AS n FROM learnings WHERE status = 'pending' AND kind = ?`).get(kind)
    : getDb().prepare(`SELECT COUNT(*) AS n FROM learnings WHERE status = 'pending'`).get();
  return Number((row as { n: number }).n);
}

export function markLearningsConsolidated(ids: number[], prNumber: number): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  getDb()
    .prepare(`UPDATE learnings SET status = 'consolidated', pr_number = ? WHERE id IN (${placeholders})`)
    .run(prNumber, ...ids);
}

export function dismissLearning(id: number, reason?: string): void {
  getDb()
    .prepare(`UPDATE learnings SET status = 'dismissed', reason = ? WHERE id = ?`)
    .run(reason ?? null, id);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/db.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add src/db.ts src/db.test.ts
git commit -m "feat(db): learnings table and CRUD for the self-improvement loop"
```

---

### Task 2: `parseLearnings` + `stripLearningsDeclaration` (pure parser)

**Files:**
- Create: `src/learnings.ts`
- Test: `src/learnings.test.ts`

**Interfaces:**
- Produces:
  - `interface RepoLearning { path: string; summary: string; }`
  - `interface ParsedLearnings { declared: boolean; repo: RepoLearning[]; yeti: string[]; }`
  - `parseLearnings(output: string): ParsedLearnings` — `declared` is true iff at least one `LEARNINGS-REPO:` or `LEARNINGS-YETI:` line exists
  - `stripLearningsDeclaration(output: string): string` — removes declaration lines (for GitHub-facing output)

- [ ] **Step 1: Write the failing tests**

Create `src/learnings.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./config.js", () => ({
  LEARNINGS_PENDING_THRESHOLD: 5,
}));
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

const { mockClaude, mockDb } = vi.hoisted(() => ({
  mockClaude: {
    runAI: vi.fn(),
    resolveEnqueue: vi.fn(),
    enqueue: vi.fn(),
    hasTreeDiff: vi.fn(),
  },
  mockDb: {
    insertLearning: vi.fn().mockReturnValue(1),
    countPendingLearnings: vi.fn().mockReturnValue(0),
  },
}));
vi.mock("./claude.js", () => mockClaude);
vi.mock("./db.js", () => mockDb);

import { parseLearnings, stripLearningsDeclaration } from "./learnings.js";

describe("parseLearnings", () => {
  it("parses none/none as declared with no learnings", () => {
    const out = "did the work\n\nLEARNINGS-REPO: none\nLEARNINGS-YETI: none\n";
    expect(parseLearnings(out)).toEqual({ declared: true, repo: [], yeti: [] });
  });

  it("parses a repo learning with path and summary", () => {
    const out = "LEARNINGS-REPO: yeti/learnings/vite-proxy.md: dev proxy needs /webhooks too\nLEARNINGS-YETI: none";
    expect(parseLearnings(out)).toEqual({
      declared: true,
      repo: [{ path: "yeti/learnings/vite-proxy.md", summary: "dev proxy needs /webhooks too" }],
      yeti: [],
    });
  });

  it("parses a yeti learning and multiple repo lines", () => {
    const out = [
      "LEARNINGS-REPO: yeti/learnings/a.md: first",
      "LEARNINGS-REPO: yeti/learnings/b.md: second",
      "LEARNINGS-YETI: gh pr create needs --head with detached worktrees",
    ].join("\n");
    const parsed = parseLearnings(out);
    expect(parsed.repo).toHaveLength(2);
    expect(parsed.yeti).toEqual(["gh pr create needs --head with detached worktrees"]);
  });

  it("returns declared=false when no declaration lines exist", () => {
    expect(parseLearnings("just some output")).toEqual({ declared: false, repo: [], yeti: [] });
  });

  it("is case-insensitive on 'none' and tolerates leading whitespace", () => {
    const out = "  LEARNINGS-REPO: NONE\n  LEARNINGS-YETI: None";
    expect(parseLearnings(out)).toEqual({ declared: true, repo: [], yeti: [] });
  });

  it("ignores a malformed repo value (no .md path) without throwing", () => {
    const out = "LEARNINGS-REPO: something vague\nLEARNINGS-YETI: none";
    const parsed = parseLearnings(out);
    expect(parsed.declared).toBe(true);
    expect(parsed.repo).toEqual([]);
  });
});

describe("stripLearningsDeclaration", () => {
  it("removes declaration lines and collapses blank runs", () => {
    const out = "## Plan\n\ndetails\n\nLEARNINGS-REPO: none\nLEARNINGS-YETI: none";
    expect(stripLearningsDeclaration(out)).toBe("## Plan\n\ndetails");
  });

  it("returns output unchanged when there is no declaration", () => {
    expect(stripLearningsDeclaration("plain output")).toBe("plain output");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/learnings.test.ts`
Expected: FAIL — module `./learnings.js` not found.

- [ ] **Step 3: Implement**

Create `src/learnings.ts` (parser only for now; the gate — and its `claude`/`db`/`log`/`config` imports — lands in Task 5. The test file's `vi.mock` calls for modules this file doesn't import yet are harmless in vitest):

```ts
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
  return output
    .replace(/^\s*LEARNINGS-(REPO|YETI):.*$/gim, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
}
```

Note: this file stays free of `claude`/`db`/`config` imports until Task 5, so the repo typechecks after every task in order (Task 3 adds `LEARNINGS_PENDING_THRESHOLD` to config before Task 5 needs it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/learnings.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/learnings.ts src/learnings.test.ts
git commit -m "feat(learnings): declaration parser and stripper"
```

---

### Task 3: Config fields (`learningConsolidatorHour`, `learningsPendingThreshold`)

**Files:**
- Modify: `src/config.ts` (ConfigFile ~line 98-105 and 116; loadConfig schedules ~line 160-167 and threshold near maxPlanRounds ~line 253; exports ~line 305; reloadConfig ~line 374)
- Modify: `src/api.ts` (`buildConfigUpdate()` ~line 168)
- Modify: `web/src/routes/Config.tsx` (draft init ~line 48, payload ~line 85, form field ~line 131; schedules render generically — no edit needed there)
- Modify: `deploy/install.sh` (sample config: schedules block ~line 77-83, top-level near `"maxPlanRounds"` ~line 95)

**Interfaces:**
- Produces: `LEARNINGS_PENDING_THRESHOLD: number` (live-reloadable export from `src/config.js`, default 5, min 1); `SCHEDULES.learningConsolidatorHour: number` (default 6).

- [ ] **Step 1: Edit `src/config.ts`**

In `ConfigFile.schedules` add:

```ts
    learningConsolidatorHour?: number;
```

In `ConfigFile` (top level, after `maxPlanRounds?: number;`):

```ts
  learningsPendingThreshold?: number;
```

In `loadConfig()`'s `schedules` object add:

```ts
    learningConsolidatorHour: file.schedules?.learningConsolidatorHour ?? 6, // 6 AM local time
```

After the `maxPlanRounds` computation add:

```ts
  const parsedLearningsThreshold = file.learningsPendingThreshold ?? 5;
  const learningsPendingThreshold = Number.isFinite(parsedLearningsThreshold) && parsedLearningsThreshold >= 1
    ? Math.floor(parsedLearningsThreshold)
    : 5;
```

Add `learningsPendingThreshold` to the returned object of `loadConfig()`.

With the other live exports (after `MAX_PLAN_ROUNDS`):

```ts
export let LEARNINGS_PENDING_THRESHOLD = config.learningsPendingThreshold;
```

In `reloadConfig()` (after `MAX_PLAN_ROUNDS = fresh.maxPlanRounds;`):

```ts
  LEARNINGS_PENDING_THRESHOLD = fresh.learningsPendingThreshold;
```

- [ ] **Step 2: Whitelist in `buildConfigUpdate()` (`src/api.ts`)**

After the `maxPlanRounds` block:

```ts
  if (typeof b.learningsPendingThreshold === "number" && Number.isFinite(b.learningsPendingThreshold) && b.learningsPendingThreshold >= 1) {
    updates.learningsPendingThreshold = b.learningsPendingThreshold;
  }
```

(The new schedule hour flows through the existing generic `b.schedules` 0–23 loop — no edit needed.)

- [ ] **Step 3: Config form (`web/src/routes/Config.tsx`)**

Mirror the `maxPlanRounds` handling exactly: in the draft initializer add `learningsPendingThreshold: num(cfg.learningsPendingThreshold, 5),`; in the save payload add `learningsPendingThreshold: Number(d.learningsPendingThreshold),`; next to the "Max plan rounds" field add:

```tsx
<Field label="Learnings PR threshold"><TextInput type="number" min={1} value={String(draft.learningsPendingThreshold ?? 5)} onChange={(e) => set("learningsPendingThreshold", e.target.value)} /></Field>
```

(The "Daily schedules" section maps over config values, so `learningConsolidatorHour` appears automatically.)

- [ ] **Step 4: `deploy/install.sh` sample config**

In the `"schedules"` block add `"learningConsolidatorHour": 6` (mind trailing commas), and near `"maxPlanRounds": 3,` add `"learningsPendingThreshold": 5,`.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run typecheck:web && npx vitest run src/config.test.ts src/api.test.ts 2>/dev/null || npx vitest run src/config.test.ts`
Expected: typechecks clean; config tests pass (there is no `src/api.test.ts`; server routes are covered in `src/server.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/api.ts web/src/routes/Config.tsx deploy/install.sh
git commit -m "feat(config): learning-consolidator schedule and pending threshold"
```

---

### Task 4: Preamble mandate (`_preamble.md`)

**Files:**
- Modify: `src/policies/_preamble.md`

- [ ] **Step 1: Append the mandate**

Append to `src/policies/_preamble.md` (below the existing Homebrew paragraph):

```md

## Self-Improvement Loop

Every session must produce two outputs: the work itself, and the learning derived from it. Before finishing, ask: did this session surface a workaround, a non-obvious pattern or convention, or a trial-and-error discovery a future agent would otherwise re-discover?

Write it down when it is: a workaround for an upstream bug (link the issue), a non-obvious pattern required for correctness, a non-obvious convention, or a hard-won trial-and-error discovery. Do NOT write: one-off task notes, obvious knowledge, or ephemeral state. Never create changelog files, "append here" sections, or session notes.

- **Repository learnings** (about the repository you are working in): write each to `yeti/learnings/<slug>.md` in that repository (create the directory if needed) and commit it together with your work.
- **Environment learnings** (about this managed environment or its tooling, not the repository): do not write files — declare them in your final output.

End your final message with exactly these two lines, always both, even when there is nothing to report:

LEARNINGS-REPO: none
LEARNINGS-YETI: none

Replace `none` when you have something to report: `LEARNINGS-REPO: yeti/learnings/<slug>.md: <one-line summary>` (repeat the line for multiple files) or `LEARNINGS-YETI: <one-line environment/tooling learning>`.
```

- [ ] **Step 2: Run the full server test suite**

Run: `npx vitest run --project server`
Expected: PASS — job-prompt tests use `stripPreamble()` (`src/test-preamble.ts`), which strips whatever `readPreamble()` returns, so the longer preamble is transparent. If any test asserts on preamble content directly (check `src/policy.test.ts`), update its expectation to match the new file.

- [ ] **Step 3: Commit**

```bash
git add src/policies/_preamble.md
git commit -m "feat(policy): self-improvement mandate in the shared preamble"
```

---

### Task 5: The mechanical gate (`enforceLearnings`) + pathspec tree-diff

**Files:**
- Modify: `src/claude.ts` (`hasTreeDiff` ~line 344)
- Modify: `src/learnings.ts` (replace the `void` placeholder block with the gate)
- Test: `src/learnings.test.ts` (extend)

**Interfaces:**
- Consumes: `claude.hasTreeDiff`, `claude.resolveEnqueue`, `claude.runAI`, `db.insertLearning`, `db.countPendingLearnings`, `LEARNINGS_PENDING_THRESHOLD`.
- Produces:
  - `hasTreeDiff(wtPath: string, baseBranch: string, pathspec?: string): Promise<boolean>` (backward-compatible optional param)
  - `interface GateContext { jobName: string; repo: string; wtPath: string; baseBranch: string; aiOptions?: AiOptions; }`
  - `enforceLearnings(output: string, ctx: GateContext): Promise<void>` — never throws
  - `setConsolidatorTrigger(fn: () => void): void`

- [ ] **Step 1: Extend `hasTreeDiff` with a pathspec**

In `src/claude.ts` replace the body of `hasTreeDiff`:

```ts
/** Check if the worktree tree actually differs from the base branch (guards against no-op commits).
 *  With `pathspec`, checks only that subtree (e.g. "yeti/" for the learnings gate). */
export async function hasTreeDiff(wtPath: string, baseBranch: string, pathspec?: string): Promise<boolean> {
  const args = ["diff", "--quiet", `origin/${baseBranch}`, "HEAD"];
  if (pathspec) args.push("--", pathspec);
  const result = await gitRaw(args, wtPath);
  return result.code !== 0;
}
```

- [ ] **Step 2: Write the failing gate tests**

Append to `src/learnings.test.ts` (the mocks from Task 2 are already in place; add `enforceLearnings, setConsolidatorTrigger` to the import from `./learnings.js` and add `import * as log from "./log.js";` at the top):

```ts
describe("enforceLearnings", () => {
  const ctx = { jobName: "issue-worker", repo: "org/repo", wtPath: "/tmp/wt", baseBranch: "main" };

  beforeEach(() => {
    vi.clearAllMocks();
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.resolveEnqueue.mockReturnValue(mockClaude.enqueue);
    mockClaude.runAI.mockResolvedValue("LEARNINGS-REPO: none\nLEARNINGS-YETI: none");
    mockClaude.hasTreeDiff.mockResolvedValue(true);
    mockDb.insertLearning.mockReturnValue(1);
    mockDb.countPendingLearnings.mockReturnValue(0);
    setConsolidatorTrigger(null as unknown as () => void);
  });

  it("declaration present with none/none → no retry, no inserts", async () => {
    await enforceLearnings("done\nLEARNINGS-REPO: none\nLEARNINGS-YETI: none", ctx);
    expect(mockClaude.runAI).not.toHaveBeenCalled();
    expect(mockDb.insertLearning).not.toHaveBeenCalled();
  });

  it("yeti learning → inserted into db", async () => {
    await enforceLearnings("LEARNINGS-REPO: none\nLEARNINGS-YETI: use brew", ctx);
    expect(mockDb.insertLearning).toHaveBeenCalledWith("issue-worker", "org/repo", "yeti", "use brew");
  });

  it("missing declaration → retries once and captures the retry's learnings", async () => {
    mockClaude.runAI.mockResolvedValueOnce("LEARNINGS-REPO: none\nLEARNINGS-YETI: retry learning");
    await enforceLearnings("no declaration here", ctx);
    expect(mockClaude.runAI).toHaveBeenCalledTimes(1);
    expect(mockDb.insertLearning).toHaveBeenCalledWith("issue-worker", "org/repo", "yeti", "retry learning");
  });

  it("still missing after retry → warns and returns without throwing", async () => {
    mockClaude.runAI.mockResolvedValueOnce("still nothing");
    await enforceLearnings("no declaration", ctx);
    expect(mockDb.insertLearning).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it("repo learning claimed but no yeti/ tree diff → warns, does not throw", async () => {
    mockClaude.hasTreeDiff.mockResolvedValue(false);
    await enforceLearnings("LEARNINGS-REPO: yeti/learnings/x.md: claimed\nLEARNINGS-YETI: none", ctx);
    expect(mockClaude.hasTreeDiff).toHaveBeenCalledWith("/tmp/wt", "main", "yeti/");
    expect(log.warn).toHaveBeenCalled();
  });

  it("threshold reached → fires the consolidator trigger", async () => {
    const trigger = vi.fn();
    setConsolidatorTrigger(trigger);
    mockDb.countPendingLearnings.mockReturnValue(5);
    await enforceLearnings("LEARNINGS-REPO: none\nLEARNINGS-YETI: hit threshold", ctx);
    expect(trigger).toHaveBeenCalled();
  });

  it("below threshold → trigger not fired", async () => {
    const trigger = vi.fn();
    setConsolidatorTrigger(trigger);
    mockDb.countPendingLearnings.mockReturnValue(3);
    await enforceLearnings("LEARNINGS-REPO: none\nLEARNINGS-YETI: below threshold", ctx);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("retry runAI rejection is swallowed — the gate never throws", async () => {
    mockClaude.runAI.mockRejectedValueOnce(new Error("timeout"));
    await expect(enforceLearnings("no declaration", ctx)).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/learnings.test.ts`
Expected: FAIL — `enforceLearnings` not exported.

- [ ] **Step 4: Implement the gate**

In `src/learnings.ts`, add these imports at the top:

```ts
import * as claude from "./claude.js";
import type { AiOptions } from "./claude.js";
import * as db from "./db.js";
import * as log from "./log.js";
import { LEARNINGS_PENDING_THRESHOLD } from "./config.js";
```

then append the gate:

```ts
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
  `Review the work you just completed in this directory (check \`git log\` and \`git diff\` if needed). If you discovered a workaround, non-obvious pattern, or trial-and-error discovery worth recording for future agents, write it to \`yeti/learnings/<slug>.md\` and commit it now. If you hit friction with this managed environment or its tooling, prepare a one-line summary.`,
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

    for (const summary of parsed.yeti) {
      db.insertLearning(ctx.jobName, ctx.repo, "yeti", summary);
      log.info(`[learnings] ${ctx.jobName}: recorded environment learning: ${summary}`);
    }

    if (parsed.yeti.length > 0 && db.countPendingLearnings("yeti") >= LEARNINGS_PENDING_THRESHOLD) {
      consolidatorTrigger?.();
    }
  } catch (err) {
    log.warn(`[learnings] gate failed for ${ctx.jobName}: ${err}`);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/learnings.test.ts src/claude.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/learnings.ts src/learnings.test.ts src/claude.ts
git commit -m "feat(learnings): mechanical gate with retry, tree-diff verification, and threshold trigger"
```

---

### Task 6: Wire the gate into work jobs + strip declarations from GitHub-facing output

**Files:**
- Modify: `src/jobs/issue-worker.ts` (~line 196)
- Modify: `src/jobs/ci-fixer.ts` (conflict site ~line 60, fix site ~line 227; the classify call ~line 124 and revert ~line 336 stay ungated)
- Modify: `src/jobs/review-addresser.ts` (~line 46 and the comment at ~line 61)
- Modify: `src/jobs/improvement-identifier.ts` (implement site ~line 160; the analysis call ~line 115 stays ungated)
- Modify: `src/jobs/issue-refiner.ts` (strip at lines ~123, ~188, ~210, ~284)
- Modify: `src/jobs/plan-reviewer.ts` (strip at line ~92)
- Modify: `src/jobs/triage-yeti-errors.ts` (strip the report body ~line 270)
- Test: the corresponding `*.test.ts` files (add a `learnings.js` mock; add one gate-invocation assertion to issue-worker)

**Interfaces:**
- Consumes: `enforceLearnings(output, {jobName, repo, wtPath, baseBranch, aiOptions})` and `stripLearningsDeclaration(output)` from Task 2/5.

Gated jobs are exactly the four work jobs (issue-worker, ci-fixer conflict+fix, review-addresser, improvement-identifier implement). Judges/classifiers/generators and learning-consolidator itself stay ungated. Because the preamble mandate reaches EVERY prompt, any job that posts raw AI output to GitHub must strip the declaration lines first — parse (gate) before strip.

- [ ] **Step 1: Write the failing test (issue-worker)**

In `src/jobs/issue-worker.test.ts`, add with the other `vi.mock` calls:

```ts
const mockEnforceLearnings = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../learnings.js", () => ({
  enforceLearnings: mockEnforceLearnings,
  stripLearningsDeclaration: (s: string) => s,
}));
```

Add a test inside the `single-PR flow` describe:

```ts
it("runs the learnings gate after the AI session", async () => {
  const issue = mockIssue({ labels: [{ name: "Refined" }] });
  mockGh.listIssuesByLabel.mockResolvedValueOnce([issue]);

  await run([repo]);

  expect(mockEnforceLearnings).toHaveBeenCalledWith("implemented", expect.objectContaining({
    jobName: "issue-worker",
    repo: repo.fullName,
    baseBranch: repo.defaultBranch,
  }));
});
```

Run: `npx vitest run src/jobs/issue-worker.test.ts` — expected: FAIL (gate never called).

- [ ] **Step 2: Wire issue-worker**

In `src/jobs/issue-worker.ts` add `import { enforceLearnings } from "../learnings.js";` and change the runAI line in `processIssue` from:

```ts
    await claude.resolveEnqueue(aiOptions)(() => claude.runAI(prompt, wtPath!, aiOptions), gh.isItemPrioritized(fullName, issue.number) || gh.hasPriorityLabel(issue.labels));
```

to:

```ts
    const output = await claude.resolveEnqueue(aiOptions)(() => claude.runAI(prompt, wtPath!, aiOptions), gh.isItemPrioritized(fullName, issue.number) || gh.hasPriorityLabel(issue.labels));
    await enforceLearnings(output, { jobName: "issue-worker", repo: fullName, wtPath, baseBranch: repo.defaultBranch, aiOptions });
```

Run: `npx vitest run src/jobs/issue-worker.test.ts` — expected: PASS.

- [ ] **Step 3: Wire ci-fixer (two sites) and strip nothing (ci-fixer posts no raw output)**

In `src/jobs/ci-fixer.ts` add `import { enforceLearnings } from "../learnings.js";`.

Conflict site (~line 60), change:

```ts
    await claude.resolveEnqueue(aiOptions)(() => claude.runAI(prompt, wtPath!, aiOptions), gh.hasPriorityLabel(pr.labels));
```

to:

```ts
    const output = await claude.resolveEnqueue(aiOptions)(() => claude.runAI(prompt, wtPath!, aiOptions), gh.hasPriorityLabel(pr.labels));
    await enforceLearnings(output, { jobName: "ci-fixer", repo: fullName, wtPath, baseBranch: pr.headRefName, aiOptions });
```

Fix site in `fixCI` (~line 227): identical transformation (same variable names).

In `src/jobs/ci-fixer.test.ts` add the same `vi.mock("../learnings.js", ...)` block as Step 1.

- [ ] **Step 4: Wire review-addresser + strip its comment**

In `src/jobs/review-addresser.ts` add `import { enforceLearnings, stripLearningsDeclaration } from "../learnings.js";`. After the `claudeOutput` line (~line 46) insert:

```ts
    await enforceLearnings(claudeOutput, { jobName: "review-addresser", repo: fullName, wtPath, baseBranch: pr.headRefName, aiOptions });
```

Change the comment block (~line 61) from `if (claudeOutput.trim()) { await gh.commentOnIssue(fullName, pr.number, claudeOutput.trim());` to:

```ts
    const commentBody = stripLearningsDeclaration(claudeOutput).trim();
    if (commentBody) {
      await gh.commentOnIssue(fullName, pr.number, commentBody);
```

(keep the existing log lines and else branch; the else condition now keys off `commentBody`).

In `src/jobs/review-addresser.test.ts` add the `learnings.js` mock block.

- [ ] **Step 5: Wire improvement-identifier (implement site only)**

In `src/jobs/improvement-identifier.ts` add `import { enforceLearnings } from "../learnings.js";` and change the implement-phase call (~line 160):

```ts
      const implOutput = await claude.resolveEnqueue(aiOptions)(() => claude.runAI(implPrompt, implWt!, aiOptions));
      await enforceLearnings(implOutput, { jobName: "improvement-identifier", repo: fullName, wtPath: implWt, baseBranch: repo.defaultBranch, aiOptions });
```

In `src/jobs/improvement-identifier.test.ts` add the `learnings.js` mock block.

- [ ] **Step 6: Strip declarations in issue-refiner, plan-reviewer, triage-yeti-errors**

These jobs post raw AI output to GitHub; the preamble mandate will make agents append declaration lines. Add `import { stripLearningsDeclaration } from "../learnings.js";` to each and wrap the posted body:

- `src/jobs/issue-refiner.ts` line ~123 and ~188: `` `${PLAN_HEADER}\n\n${stripLearningsDeclaration(planOutput)}` ``; line ~210: `` `${PLAN_HEADER}\n\n${stripLearningsDeclaration(planBody)}` ``; line ~284: `gh.commentOnIssue(fullName, issue.number, stripLearningsDeclaration(response))`.
- `src/jobs/plan-reviewer.ts` line ~92: `` `${REVIEW_HEADER}\n\n${stripLearningsDeclaration(commentBody)}` ``.
- `src/jobs/triage-yeti-errors.ts` ~line 270, change `const reportBody = output.replace(/\nRELATED_ISSUES:.*$/m, "").trim();` to:

```ts
      const reportBody = stripLearningsDeclaration(output.replace(/\nRELATED_ISSUES:.*$/m, "")).trim();
```

Add the `learnings.js` mock block (with identity `stripLearningsDeclaration`) to `issue-refiner.test.ts`, `plan-reviewer.test.ts`, and `triage-yeti-errors.test.ts`.

- [ ] **Step 7: Run all affected tests**

Run: `npx vitest run src/jobs/ src/learnings.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/jobs/ src/learnings.ts
git commit -m "feat(jobs): learnings gate in work jobs; strip declarations from GitHub output"
```

---

### Task 7: `learning-consolidator` job + policy + registration

**Files:**
- Create: `src/policies/learning-consolidator.md`
- Create: `src/jobs/learning-consolidator.ts`
- Test: `src/jobs/learning-consolidator.test.ts`
- Modify: `src/main.ts` (import ~line 25, jobs array ~line 262, trigger wiring after `startJobs` ~line 285)
- Modify: `src/job-meta.ts` (JOB_DESCRIPTIONS)

**Interfaces:**
- Consumes: `db.getPendingLearnings("yeti")`, `db.markLearningsConsolidated`, `db.dismissLearning`, `gh.listPRs(repo, {fresh: true})`, `gh.createPR`, `claude.createWorktree/runAI/hasNewCommits/hasTreeDiff/pushBranch/removeWorktree/datestamp/randomSuffix`, `renderPolicy`, `can`, `setConsolidatorTrigger`.
- Produces: `run(repos: Repo[]): Promise<void>`; exported helpers `formatLearnings(rows)`, `parseDismissals(output)`, `buildPRBody(consolidated, dismissals)`.

- [ ] **Step 1: Write the policy file**

Create `src/policies/learning-consolidator.md`:

```md
You are consolidating "environment learnings" — friction that Yeti's agents reported while working in this managed environment — into Yeti's durable prompt/policy files so future agents never hit the same friction twice.

First read `yeti/OVERVIEW.md`, then read `src/policies/_preamble.md` and skim the other files in `src/policies/`.

## Pending learnings

${LEARNINGS}

## Your task

For each learning above, decide:

1. **Already covered** — the guidance already exists in `_preamble.md`, a job policy, or the `yeti/` docs. Make no edit for it; dismiss it below.
2. **Environment-wide** — it applies to every agent session (tooling, installation, git/gh usage, host conventions). Fold it into `src/policies/_preamble.md`, merging with existing guidance.
3. **Job-specific** — it only matters for one job. Fold it into that job's policy file in `src/policies/`.
4. **Architectural** — it is knowledge about the yeti codebase itself, not prompt guidance. Fold it into the appropriate doc under `yeti/`.
5. **Not actionable** — too vague, one-off, or wrong. Make no edit; dismiss it below.

Rules:
- Edit and merge; never append changelog-style entries, dates, or session notes.
- Keep the preamble short — it is prepended to every prompt. When in doubt, prefer a job policy over the preamble.
- Commit your edits with message: "chore(policies): consolidate environment learnings [learning-consolidator]"

## Output

After committing (or if you made no edits), print one line per learning you did NOT fold into a file, using its [id] from the list above:

DISMISSED: <id>: <one-line reason>

Learnings you folded into files must NOT appear in DISMISSED lines.
```

- [ ] **Step 2: Write the failing tests**

Create `src/jobs/learning-consolidator.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  SELF_REPO: "test-org/yeti",
  JOB_AI: {},
  WORK_DIR: "/tmp/yeti-lc-test",
  repoAutonomy: () => "pr",
}));
vi.mock("../log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../error-reporter.js", () => ({ reportError: vi.fn() }));
vi.mock("../capability.js", () => ({ can: vi.fn().mockReturnValue(true) }));
const mockNotify = vi.hoisted(() => vi.fn());
vi.mock("../notify.js", () => ({ notify: mockNotify }));

const { mockGh, mockClaude, mockDb } = vi.hoisted(() => ({
  mockGh: {
    listPRs: vi.fn(),
    createPR: vi.fn(),
    pullUrl: (fullName: string, number: number) => `https://github.com/${fullName}/pull/${number}`,
  },
  mockClaude: {
    createWorktree: vi.fn(),
    removeWorktree: vi.fn(),
    enqueue: vi.fn(),
    resolveEnqueue: vi.fn(),
    runAI: vi.fn(),
    hasNewCommits: vi.fn(),
    hasTreeDiff: vi.fn(),
    pushBranch: vi.fn(),
    randomSuffix: vi.fn().mockReturnValue("ab12"),
    datestamp: vi.fn().mockReturnValue("20260702"),
  },
  mockDb: {
    getPendingLearnings: vi.fn(),
    markLearningsConsolidated: vi.fn(),
    dismissLearning: vi.fn(),
    recordTaskStart: vi.fn().mockReturnValue(1),
    updateTaskWorktree: vi.fn(),
    recordTaskComplete: vi.fn(),
    recordTaskFailed: vi.fn(),
  },
}));
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);

import { run, parseDismissals, formatLearnings } from "./learning-consolidator.js";

const learning = (id: number, summary: string) => ({
  id, job_name: "issue-worker", repo: "test-org/app", kind: "yeti",
  summary, status: "pending", reason: null, pr_number: null, created_at: "2026-07-01 00:00:00",
});

describe("learning-consolidator", () => {
  const selfRepo = mockRepo({ owner: "test-org", name: "yeti", fullName: "test-org/yeti" });

  beforeEach(() => {
    vi.clearAllMocks();
    mockClaude.enqueue.mockImplementation((fn: () => Promise<string>) => fn());
    mockClaude.resolveEnqueue.mockReturnValue(mockClaude.enqueue);
    mockClaude.createWorktree.mockResolvedValue("/tmp/wt");
    mockClaude.removeWorktree.mockResolvedValue(undefined);
    mockClaude.runAI.mockResolvedValue("consolidated everything");
    mockClaude.hasNewCommits.mockResolvedValue(true);
    mockClaude.hasTreeDiff.mockResolvedValue(true);
    mockClaude.pushBranch.mockResolvedValue(undefined);
    mockGh.listPRs.mockResolvedValue([]);
    mockGh.createPR.mockResolvedValue(77);
    mockDb.getPendingLearnings.mockReturnValue([learning(1, "use brew"), learning(2, "gh needs --head")]);
  });

  it("no pending learnings → does nothing", async () => {
    mockDb.getPendingLearnings.mockReturnValue([]);
    await run([selfRepo]);
    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
  });

  it("skips when SELF_REPO is not in the repo list", async () => {
    await run([mockRepo()]);
    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
  });

  it("skips when an open learnings PR already exists (fresh list)", async () => {
    mockGh.listPRs.mockResolvedValue([{ headRefName: "yeti/learnings-20260701-xx", number: 5, title: "", baseRefName: "main", labels: [], author: { login: "yeti" }, body: "" }]);
    await run([selfRepo]);
    expect(mockGh.listPRs).toHaveBeenCalledWith("test-org/yeti", { fresh: true });
    expect(mockClaude.createWorktree).not.toHaveBeenCalled();
  });

  it("happy path — runs AI, pushes, creates PR, marks consolidated", async () => {
    await run([selfRepo]);
    expect(mockClaude.runAI).toHaveBeenCalled();
    expect(mockGh.createPR).toHaveBeenCalledWith(
      "test-org/yeti",
      "yeti/learnings-20260702-ab12",
      expect.stringContaining("2 environment learning"),
      expect.stringContaining("use brew"),
    );
    expect(mockDb.markLearningsConsolidated).toHaveBeenCalledWith([1, 2], 77);
    expect(mockDb.recordTaskComplete).toHaveBeenCalled();
  });

  it("dismissals from output are applied and excluded from the PR set", async () => {
    mockClaude.runAI.mockResolvedValue("done\nDISMISSED: 2: already covered by preamble");
    await run([selfRepo]);
    expect(mockDb.dismissLearning).toHaveBeenCalledWith(2, "already covered by preamble");
    expect(mockDb.markLearningsConsolidated).toHaveBeenCalledWith([1], 77);
  });

  it("all dismissed → no PR", async () => {
    mockClaude.runAI.mockResolvedValue("DISMISSED: 1: vague\nDISMISSED: 2: vague");
    await run([selfRepo]);
    expect(mockGh.createPR).not.toHaveBeenCalled();
    expect(mockDb.markLearningsConsolidated).not.toHaveBeenCalled();
  });

  it("no tree diff → leaves learnings pending, no PR", async () => {
    mockClaude.hasTreeDiff.mockResolvedValue(false);
    await run([selfRepo]);
    expect(mockGh.createPR).not.toHaveBeenCalled();
    expect(mockDb.markLearningsConsolidated).not.toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).toHaveBeenCalled();
  });

  it("AI failure → task failed, worktree cleaned, no throw", async () => {
    mockClaude.runAI.mockRejectedValue(new Error("boom"));
    await run([selfRepo]);
    expect(mockDb.recordTaskFailed).toHaveBeenCalled();
    expect(mockClaude.removeWorktree).toHaveBeenCalled();
  });
});

describe("parseDismissals", () => {
  it("parses id and reason lines, ignoring other text", () => {
    expect(parseDismissals("blah\nDISMISSED: 3: too vague\nDISMISSED: 10: wrong")).toEqual([
      { id: 3, reason: "too vague" },
      { id: 10, reason: "wrong" },
    ]);
  });
  it("returns empty for output with no dismissals", () => {
    expect(parseDismissals("all folded in")).toEqual([]);
  });
});

describe("formatLearnings", () => {
  it("renders one bullet per learning with its id", () => {
    const text = formatLearnings([learning(7, "use brew")]);
    expect(text).toContain("[7]");
    expect(text).toContain("use brew");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/jobs/learning-consolidator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the job**

Create `src/jobs/learning-consolidator.ts`:

```ts
import { SELF_REPO, JOB_AI, repoAutonomy, type Repo } from "../config.js";
import { can } from "../capability.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";
import { notify } from "../notify.js";
import { renderPolicy } from "../policy.js";

/** Render pending learnings as the ${LEARNINGS} policy block, one [id] bullet each. */
export function formatLearnings(rows: db.LearningRow[]): string {
  return rows
    .map((l) => `- [${l.id}] (reported by ${l.job_name} while working on ${l.repo}, ${l.created_at}) ${l.summary}`)
    .join("\n");
}

/** Parse `DISMISSED: <id>: <reason>` lines from the agent's output. */
export function parseDismissals(output: string): Array<{ id: number; reason: string }> {
  const out: Array<{ id: number; reason: string }> = [];
  for (const m of output.matchAll(/^DISMISSED:\s*(\d+)\s*:\s*(.+)$/gim)) {
    out.push({ id: parseInt(m[1], 10), reason: m[2].trim() });
  }
  return out;
}

export function buildPRBody(
  consolidated: db.LearningRow[],
  dismissals: Array<{ id: number; reason: string }>,
): string {
  const lines = [
    `Consolidates environment learnings reported by agents during work sessions into the durable policy/docs files.`,
    ``,
    `## Learnings folded in`,
    ...consolidated.map((l) => `- ${l.summary} _(via ${l.job_name} on ${l.repo})_`),
  ];
  if (dismissals.length > 0) {
    lines.push(``, `## Dismissed`, ...dismissals.map((d) => `- [${d.id}] ${d.reason}`));
  }
  lines.push(``, `_Opened automatically by the learning-consolidator job. Merging deploys these learnings into every future agent prompt._`);
  return lines.join("\n");
}

export async function run(repos: Repo[]): Promise<void> {
  const selfRepo = repos.find((r) => r.fullName === SELF_REPO);
  if (!selfRepo) return;
  if (!can(selfRepo, "createPR")) {
    log.info(`[learning-consolidator] skip — tier below 'createPR' requirement`);
    return;
  }

  const pending = db.getPendingLearnings("yeti");
  if (pending.length === 0) return;

  try {
    // Fresh list bypasses the 60s TTL cache — avoids racing a just-created PR.
    const openPRs = await gh.listPRs(SELF_REPO, { fresh: true });
    if (openPRs.some((pr) => pr.headRefName.startsWith("yeti/learnings-"))) {
      log.info(`[learning-consolidator] Skipping — open learnings PR already exists`);
      return;
    }
  } catch (err) {
    reportError("learning-consolidator:list-prs", SELF_REPO, err);
    return;
  }

  log.info(`[learning-consolidator] Consolidating ${pending.length} pending learning(s)`);
  const branchName = `yeti/learnings-${claude.datestamp()}-${claude.randomSuffix()}`;
  const taskId = db.recordTaskStart("learning-consolidator", SELF_REPO, 0, null);
  let wtPath: string | undefined;

  try {
    wtPath = await claude.createWorktree(selfRepo, branchName, "learning-consolidator");
    db.updateTaskWorktree(taskId, wtPath, branchName);

    const prompt = renderPolicy("learning-consolidator", repoAutonomy(selfRepo), {
      LEARNINGS: formatLearnings(pending),
    });
    const aiOptions = JOB_AI["learning-consolidator"];
    const output = await claude.resolveEnqueue(aiOptions)(() => claude.runAI(prompt, wtPath!, aiOptions));

    const pendingIds = new Set(pending.map((l) => l.id));
    const dismissals = parseDismissals(output).filter((d) => pendingIds.has(d.id));
    for (const d of dismissals) {
      db.dismissLearning(d.id, d.reason);
      log.info(`[learning-consolidator] Dismissed learning ${d.id}: ${d.reason}`);
    }

    const dismissedIds = new Set(dismissals.map((d) => d.id));
    const consolidated = pending.filter((l) => !dismissedIds.has(l.id));

    if (
      consolidated.length > 0 &&
      (await claude.hasNewCommits(wtPath, selfRepo.defaultBranch)) &&
      (await claude.hasTreeDiff(wtPath, selfRepo.defaultBranch))
    ) {
      await claude.pushBranch(wtPath, branchName, SELF_REPO);
      const prNumber = await gh.createPR(
        SELF_REPO,
        branchName,
        `chore(learnings): consolidate ${consolidated.length} environment learning(s)`,
        buildPRBody(consolidated, dismissals),
      );
      db.markLearningsConsolidated(consolidated.map((l) => l.id), prNumber);
      log.info(`[learning-consolidator] Created PR #${prNumber} consolidating ${consolidated.length} learning(s)`);
      notify({
        jobName: "learning-consolidator",
        message: `Created PR #${prNumber} consolidating ${consolidated.length} learning(s)`,
        url: gh.pullUrl(SELF_REPO, prNumber),
      });
    } else if (consolidated.length > 0) {
      log.warn(`[learning-consolidator] ${consolidated.length} learning(s) not dismissed but no changes produced — leaving pending`);
    }

    db.recordTaskComplete(taskId);
  } catch (err) {
    db.recordTaskFailed(taskId, String(err));
    reportError("learning-consolidator:run", SELF_REPO, err);
  } finally {
    if (wtPath) {
      await claude.removeWorktree(selfRepo, wtPath);
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/jobs/learning-consolidator.test.ts`
Expected: PASS.

- [ ] **Step 6: Register in main.ts, job-meta, and wire the trigger**

`src/main.ts`:
- With the job imports: `import * as learningConsolidator from "./jobs/learning-consolidator.js";` and `import { setConsolidatorTrigger } from "./learnings.js";`
- In the `jobs` array after `prompt-evaluator`:

```ts
  {
    name: "learning-consolidator",
    intervalMs: 0,
    scheduledHour: SCHEDULES.learningConsolidatorHour,
    async run() {
      const repos = await gh.listRepos();
      await learningConsolidator.run(repos);
    },
  },
```

- After `const scheduler = startJobs(...)`:

```ts
setConsolidatorTrigger(() => {
  const result = scheduler.triggerJob("learning-consolidator");
  if (result !== "started") log.info(`[learnings] consolidator threshold trigger: ${result}`);
});
```

(The generic `onConfigChange` schedule-sync regex converts `learningConsolidatorHour` → `learning-consolidator` automatically — no edit needed.)

`src/job-meta.ts` — add to `JOB_DESCRIPTIONS`:

```ts
  "learning-consolidator": "Consolidates agent-reported environment learnings into policies via PR",
```

- [ ] **Step 7: Full server suite + typecheck**

Run: `npm run typecheck && npx vitest run --project server`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/policies/learning-consolidator.md src/jobs/learning-consolidator.ts src/jobs/learning-consolidator.test.ts src/main.ts src/job-meta.ts
git commit -m "feat(jobs): learning-consolidator job — PRs environment learnings into policies"
```

---

### Task 8: API — `/api/learnings`, dismiss route, overview count

**Files:**
- Modify: `src/api.ts` (imports ~line 6-11; POST section before the closing 404 ~line 386; GET section near `/api/notifications` ~line 463; `buildOverviewPayload` ~line 100)

**Interfaces:**
- Produces:
  - `GET /api/learnings[?status=pending|consolidated|dismissed]` → `Array<{id, jobName, repo, kind, summary, status, reason, prNumber, createdAt}>`
  - `POST /api/learnings/:id/dismiss` body `{reason?: string}` → `{result: "dismissed"}`
  - `GET /api/overview` counts gains `pendingLearnings: number`

- [ ] **Step 1: Implement**

Add `getLearnings, countPendingLearnings, dismissLearning` to the `./db.js` import in `src/api.ts`.

In `buildOverviewPayload`, extend `counts`:

```ts
  const counts = {
    running: (status.runningTasks as unknown[]).length,
    queuePending: getQueueSnapshot(ALL_CATEGORIES).items.length,
    recentDone,
    recentFailed,
    pendingLearnings: countPendingLearnings(),
  };
```

In the POST section, before the final `sendJson(res, 404, ...)`:

```ts
    // /api/learnings/:id/dismiss
    const learningMatch = /^\/api\/learnings\/(\d+)\/dismiss$/.exec(p);
    if (learningMatch) {
      try {
        const id = parseInt(learningMatch[1], 10);
        let reason: string | undefined;
        const raw = await readBody(req);
        if (raw) {
          try { reason = String((JSON.parse(raw) as { reason?: unknown }).reason ?? "") || undefined; } catch { /* invalid json — dismiss without reason */ }
        }
        dismissLearning(id, reason);
        sendJson(res, 200, { result: "dismissed" });
      } catch (err) {
        sendJson(res, 500, { error: String(err) });
      }
      return;
    }
```

In the GET section, next to `/api/notifications`:

```ts
    if (p === "/api/learnings") {
      const status = urlObj.searchParams.get("status") ?? undefined;
      sendJson(res, 200, getLearnings(status).map(l => ({
        id: l.id, jobName: l.job_name, repo: l.repo, kind: l.kind, summary: l.summary,
        status: l.status, reason: l.reason, prNumber: l.pr_number, createdAt: l.created_at,
      })));
      return;
    }
```

- [ ] **Step 2: Server test**

`src/server.test.ts` exercises `/api/*` routes end-to-end; add coverage there following its existing route-test pattern (auth setup, request helper): one test that `GET /api/learnings` returns an inserted learning as camelCase JSON, and one that `POST /api/learnings/:id/dismiss` flips status. If `server.test.ts` mocks `db.js` wholesale, add `getLearnings`/`countPendingLearnings`/`dismissLearning` stubs to that mock instead and assert the routes call them.

Run: `npx vitest run src/server.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/api.ts src/server.test.ts
git commit -m "feat(api): learnings endpoints and pending count on overview"
```

---

### Task 9: SPA — types, client, queries, Learnings route, nav, Overview card

**Files:**
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/lib/queries.ts`
- Create: `web/src/routes/Learnings.tsx`
- Modify: `web/src/router.tsx` (import + route after `/notifications`)
- Modify: `web/src/components/shell/AppShell.tsx` (NAV array ~line 12)
- Modify: `web/src/routes/Overview.tsx` (Factory Pulse grid ~line 67)

**Interfaces:**
- Consumes: the Task 8 API shapes.

- [ ] **Step 1: Types (`web/src/lib/types.ts`)**

```ts
export type LearningStatus = "pending" | "consolidated" | "dismissed";

export interface LearningRow {
  id: number;
  jobName: string;
  repo: string;
  kind: "repo" | "yeti";
  summary: string;
  status: LearningStatus;
  reason: string | null;
  prNumber: number | null;
  createdAt: string;
}
```

And in `Overview.counts` add `pendingLearnings: number;`:

```ts
  counts: { running: number; queuePending: number; recentDone: number; recentFailed: number; pendingLearnings: number };
```

- [ ] **Step 2: Client + queries**

`web/src/lib/api.ts` — add `LearningRow` to the type import and to the `api` object:

```ts
  learnings: (status?: string) =>
    req<LearningRow[]>(`/api/learnings${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  dismissLearning: (id: number, reason?: string) =>
    post<{ result: string }>(`/api/learnings/${id}/dismiss`, reason ? { reason } : undefined),
```

`web/src/lib/queries.ts`:

```ts
export const useLearnings = () => useQuery({ queryKey: ["learnings"], queryFn: () => api.learnings(), refetchInterval: 60_000 });

export function useDismissLearning() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; reason?: string }) => api.dismissLearning(v.id, v.reason),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["learnings"] }); qc.invalidateQueries({ queryKey: ["overview"] }); },
  });
}
```

- [ ] **Step 3: Route (`web/src/routes/Learnings.tsx`)**

Model on `Notifications.tsx`:

```tsx
import { useLearnings, useDismissLearning } from "../lib/queries";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Badge } from "../components/ui/status";
import { EmptyState, Skeleton } from "../components/ui/base";
import { RelativeTime } from "../components/ui/time";
import type { LearningRow } from "../lib/types";

const STATUS_COLOR: Record<string, string> = { pending: "#4aa8ff", consolidated: "#4ade80", dismissed: "#8b95a7" };

export function Learnings() {
  const { data, isLoading } = useLearnings();
  const dismiss = useDismissLearning();

  const cols: Column<LearningRow>[] = [
    { key: "status", header: "Status", cell: (l) => <Badge color={STATUS_COLOR[l.status]}>{l.status}</Badge> },
    { key: "job", header: "Job", cell: (l) => <span className="text-secondary">{l.jobName}</span> },
    { key: "repo", header: "Repo", cell: (l) => <span className="text-secondary">{l.repo}</span> },
    {
      key: "summary",
      header: "Learning",
      cell: (l) => (
        <span className="text-text">
          {l.summary}
          {l.status === "consolidated" && l.prNumber ? <span className="text-muted"> · PR #{l.prNumber}</span> : null}
          {l.status === "dismissed" && l.reason ? <span className="text-muted"> · {l.reason}</span> : null}
        </span>
      ),
    },
    { key: "when", header: "When", cell: (l) => <RelativeTime iso={l.createdAt} className="text-muted" /> },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (l) => l.status === "pending" ? (
        <button
          className="rounded-md border border-border px-2 py-1 text-[12px] text-secondary hover:border-border-strong hover:text-text"
          onClick={() => dismiss.mutate({ id: l.id })}
          disabled={dismiss.isPending}
        >
          Dismiss
        </button>
      ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[20px] font-semibold text-text">Learnings</h1>
        <p className="text-[13px] text-muted">Environment friction reported by agents — pending items are consolidated into policies by PR</p>
      </header>
      {isLoading ? <Skeleton className="h-40" /> : (
        <DataTable columns={cols} rows={data ?? []} rowKey={(l) => String(l.id)} empty={<EmptyState title="No learnings yet" />} />
      )}
    </div>
  );
}
```

(Verify the `RelativeTime` prop name against `Notifications.tsx` — it uses `iso`; keep identical. If `Column` lacks an `align` prop for the action column, drop it.)

- [ ] **Step 4: Router + nav + Overview card**

`web/src/router.tsx`: `import { Learnings } from "./routes/Learnings";` and after the notifications route:

```tsx
          <Route path="/learnings" element={<Learnings />} />
```

`web/src/components/shell/AppShell.tsx` NAV, before Config:

```ts
  { to: "/learnings", label: "Learnings" },
```

`web/src/routes/Overview.tsx`: add `Lightbulb` to the `lucide-react` import and a fifth card in the Factory Pulse grid (grid wraps; no class change needed):

```tsx
          <StatCard label="Learnings" value={d.counts.pendingLearnings} tone={d.counts.pendingLearnings > 0 ? "ice" : "muted"} icon={<Lightbulb size={15} />} />
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck:web && npx vitest run --project web && npm run build`
Expected: all clean. (No SPA route tests exist in this repo — `web` project has only lib tests; typecheck + build is the established verification. Optionally spot-check via `npm run dev` + `npm run dev:web`.)

- [ ] **Step 6: Commit**

```bash
git add web/src
git commit -m "feat(dashboard): learnings view, nav entry, and pending-learnings overview card"
```

---

### Task 10: doc-maintainer as composter

**Files:**
- Modify: `src/policies/doc-maintainer.md`

- [ ] **Step 1: Add the curation step**

In `src/policies/doc-maintainer.md`, insert a new step between existing steps 5 and 6 (renumber 6→7, 7→8):

```md
6. If `yeti/learnings/` contains files, treat them as seeds, not archives:
   fold each learning into the appropriate topic doc (or OVERVIEW.md's Key
   Patterns), then delete the learnings file it came from. Drop learnings
   that are stale, duplicated, or already covered. Never leave a learnings
   file that has been folded in — the directory should trend toward empty.
```

- [ ] **Step 2: Verify + commit**

Run: `npx vitest run --project server` (doc-maintainer prompt tests, if any, may assert on policy text — update expectations if so).

```bash
git add src/policies/doc-maintainer.md
git commit -m "feat(policy): doc-maintainer folds yeti/learnings seeds into topic docs"
```

---

### Task 11: Documentation

**Files:**
- Modify: `CLAUDE.md` (Core modules, Jobs section, Key patterns, Cross-Cutting Concerns are already generic — verify)
- Modify: `yeti/OVERVIEW.md`, `yeti/jobs.md`, `yeti/modules.md`, `yeti/database-schema.md`
- Modify: `README.md` (only if it enumerates jobs/features — check first)

- [ ] **Step 1: CLAUDE.md**

In **Core modules** add after the `error-reporter.ts` entry:

```md
- **`learnings.ts`** — Self-improvement loop gate. The shared preamble mandates every agent session end with a `LEARNINGS-REPO:` / `LEARNINGS-YETI:` declaration. `enforceLearnings()` runs after the main `runAI` call in work jobs (issue-worker, ci-fixer, review-addresser, improvement-identifier): missing declaration → one retry in the same worktree; claimed repo learnings are verified against a `yeti/` pathspec tree-diff; environment learnings are persisted to the `learnings` table and, at `learningsPendingThreshold` pending (default 5), trigger the learning-consolidator job. The gate never fails a task. `stripLearningsDeclaration()` removes declaration lines from AI output posted to GitHub (plans, reviews, reports, comments).
```

In the **Jobs** section add a paragraph:

```md
The `learning-consolidator` job closes the yeti-side self-improvement loop: agents declare environment/tooling friction (`LEARNINGS-YETI:`) during work sessions; the gate persists it; this job (daily at `learningConsolidatorHour`, or when the pending count reaches `learningsPendingThreshold`) runs one AI pass in a SELF_REPO worktree to fold pending learnings into `_preamble.md` / job policies / `yeti/` docs and opens a PR. Humans merge; the release flow deploys; every future prompt includes the learning. Repo-side learnings never reach yeti: agents commit them as `yeti/learnings/<slug>.md` files in the target repo's PR, and doc-maintainer later folds those seeds into topic docs.
```

In **Key patterns** add:

```md
- **Self-improvement loop**: every work session must produce the work AND the learning. Enforced mechanically by `src/learnings.ts` (see Core modules) rather than by prompt diligence alone.
```

Update `db.ts` bullet's table list to include `learnings`, and the `config.ts` bullet's export list to include `LEARNINGS_PENDING_THRESHOLD`.

- [ ] **Step 2: yeti/ docs**

- `yeti/database-schema.md`: document the `learnings` table (columns, statuses, dedup-on-insert behavior).
- `yeti/modules.md`: add `learnings.ts` (gate, parser, trigger hook) mirroring the CLAUDE.md entry with more detail (GateContext fields, never-throws contract, exempt call sites).
- `yeti/jobs.md`: add `learning-consolidator` (inputs: pending yeti learnings; policy: `learning-consolidator.md`; guards: fresh duplicate-PR check on `yeti/learnings-` branches, tree-diff; outputs: PR + status transitions; DISMISSED line protocol).
- `yeti/OVERVIEW.md`: add the loop to the architecture/patterns narrative, including the two write-back targets and the deployment note that a user-override `~/.yeti/policies/_preamble.md` shadows the bundled preamble (the mandate must be merged into any override).

- [ ] **Step 3: README.md**

Check whether README lists jobs or dashboard pages; if so add learning-consolidator / Learnings page. Also note the operational step: add `"learning-consolidator"` to `enabledJobs` to activate the loop's consolidation half (the gate itself is always on for work jobs).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md yeti/ README.md
git commit -m "docs: self-improvement loop — gate, consolidator job, learnings table"
```

---

### Task 12: Final verification pass

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: daemon + web typechecks clean, all tests pass.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: tsc and vite both succeed.

- [ ] **Step 3: Sanity checklist**

- `git status` — no unintended deletions/overwrites; `.gitignore` and embed dirs intact.
- `git log --oneline main..HEAD` — commits present and scoped as planned.
- Grep guard: `grep -rn "LEARNINGS-" src/policies/_preamble.md src/learnings.ts` — declaration format identical in both places.
- Confirm exempt paths: `grep -n "enforceLearnings" src/jobs/*.ts` shows exactly issue-worker (1), ci-fixer (2), review-addresser (1), improvement-identifier (1).

- [ ] **Step 4: Done — hand off**

Do not merge or open a PR without confirming the target branch with the user (repo default is `main`).
