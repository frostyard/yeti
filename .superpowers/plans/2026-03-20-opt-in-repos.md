# Opt-in Repository Allow-List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `allowedRepos` config field that filters which repositories jobs operate on, with the self-repo always implicitly included.

**Architecture:** Add `allowedRepos` to `ConfigFile` in `config.ts` with `null` (absent) vs `[]` (empty) semantics. Filter the repo list inside `listRepos()` in `github.ts` after fetching from GitHub — this is the single choke point for repo discovery, so all consumers (jobs, Discord, WhatsApp) get filtered results with zero changes.

**Tech Stack:** TypeScript, Node.js, Vitest

**Spec:** `.superpowers/specs/2026-03-20-opt-in-repos-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/config.ts` | Modify | Add `allowedRepos` to `ConfigFile`, `loadConfig()`, exports, `reloadConfig()` |
| `src/github.ts` | Modify | Import `ALLOWED_REPOS` + `SELF_REPO`, add filtering in `listRepos()` |
| `src/github.test.ts` | Modify | Add 7 tests for allow-list filtering in `listRepos()` |
| `deploy/install.sh` | Modify | Add `allowedRepos` to bootstrap config template |
| `README.md` | Modify | Add `allowedRepos` to config table, add migration guide section |
| `CLAUDE.md` | Modify | Mention `ALLOWED_REPOS` in `config.ts` module description |

---

### Task 1: Add `allowedRepos` to config

**Files:**
- Modify: `src/config.ts:43-78` (ConfigFile interface)
- Modify: `src/config.ts:80-177` (loadConfig body + return)
- Modify: `src/config.ts:179-205` (exports)
- Modify: `src/config.ts:232-252` (reloadConfig)

- [ ] **Step 1: Add `allowedRepos` to `ConfigFile` interface**

In `src/config.ts`, add after `prioritizedItems` (line 77):

```typescript
  allowedRepos?: string[];
```

- [ ] **Step 2: Add parsing in `loadConfig()`**

In `src/config.ts`, add after `const prioritizedItems = ...` (line 168):

```typescript
  const allowedRepos = process.env["YETI_ALLOWED_REPOS"] !== undefined
    ? process.env["YETI_ALLOWED_REPOS"].split(",").map((s) => s.trim()).filter(Boolean)
    : file.allowedRepos ?? null;
```

- [ ] **Step 3: Add to `loadConfig()` return value**

In `src/config.ts`, add `allowedRepos` to the return object on line 176.

- [ ] **Step 4: Add export**

In `src/config.ts`, add after the `PRIORITIZED_ITEMS` export (line 200):

```typescript
export let ALLOWED_REPOS: readonly string[] | null = config.allowedRepos;
```

- [ ] **Step 5: Add to `reloadConfig()`**

In `src/config.ts`, add after `PRIORITIZED_ITEMS = fresh.prioritizedItems;` (line 250):

```typescript
  ALLOWED_REPOS = fresh.allowedRepos;
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/config.ts
git commit -m "feat: add allowedRepos config field"
```

---

### Task 2: Add filtering to `listRepos()` with tests

**Files:**
- Modify: `src/github.ts:2` (imports)
- Modify: `src/github.ts:292-319` (listRepos function)
- Modify: `src/github.test.ts:11-26` (config mock)
- Test: `src/github.test.ts` (new describe block)

- [ ] **Step 1: Write failing test — `null` ALLOWED_REPOS returns all repos (no filtering)**

In `src/github.test.ts`, add a new `describe("allowedRepos filtering")` block after the existing `describe("repo cache")` block (after line 1523). The config mock at the top of the file (line 11-26) already mocks `./config.js` — add `ALLOWED_REPOS: null` and `SELF_REPO: "test-org/test-repo"` to it (SELF_REPO is already there).

First, update the config mock at line 11 to add the `ALLOWED_REPOS` field:

```typescript
vi.mock("./config.js", () => ({
  GITHUB_OWNERS: ["test-owner"],
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    priority: "Priority",
  },
  LABEL_SPECS: {
    "Refined": { color: "0075ca", description: "Issue is ready for yeti to implement" },
    "Ready": { color: "0e8a16", description: "Yeti has finished — needs human attention" },
    "Priority": { color: "d93f0b", description: "High-priority — processed first in all Yeti queues" },
  },
  SELF_REPO: "test-org/test-repo",
  SKIPPED_ITEMS: [],
  PRIORITIZED_ITEMS: [],
  ALLOWED_REPOS: null,
}));
```

Then add imports at the top of the file (after the existing imports around line 42):

```typescript
import * as config from "./config.js";
import * as log from "./log.js";
```

Then add the new test block after line 1523:

```typescript
describe("allowedRepos filtering", () => {
  const threeRepos = [
    { nameWithOwner: "test-owner/repo-a", name: "repo-a", owner: { login: "test-owner" }, defaultBranchRef: { name: "main" }, isArchived: false },
    { nameWithOwner: "test-owner/repo-b", name: "repo-b", owner: { login: "test-owner" }, defaultBranchRef: { name: "main" }, isArchived: false },
    { nameWithOwner: "test-org/test-repo", name: "test-repo", owner: { login: "test-org" }, defaultBranchRef: { name: "main" }, isArchived: false },
  ];

  beforeEach(() => {
    mockExecFile.mockReset();
    clearRepoCache();
    clearRateLimitState();
    mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
      cb(null, JSON.stringify(threeRepos), "");
    });
  });

  it("returns all repos when ALLOWED_REPOS is null (no filtering)", async () => {
    (config as any).ALLOWED_REPOS = null;
    const repos = await listRepos();
    expect(repos).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it passes (baseline — no filtering logic yet, null means all repos)**

Run: `npx vitest run src/github.test.ts -t "returns all repos when ALLOWED_REPOS is null"`
Expected: PASS (listRepos currently returns everything, which is the correct null behavior)

- [ ] **Step 3: Write failing test — filters to allowed repos + self-repo**

Add inside the `describe("allowedRepos filtering")` block:

```typescript
  it("filters to allowed repos plus self-repo", async () => {
    (config as any).ALLOWED_REPOS = ["repo-a"];
    const repos = await listRepos();
    expect(repos).toHaveLength(2);
    expect(repos.map(r => r.name).sort()).toEqual(["repo-a", "test-repo"]);
  });
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/github.test.ts -t "filters to allowed repos plus self-repo"`
Expected: FAIL — returns 3 repos instead of 2

- [ ] **Step 5: Implement filtering in `listRepos()`**

In `src/github.ts`, update the import on line 2 to add `ALLOWED_REPOS` and `SELF_REPO`:

```typescript
import { GITHUB_OWNERS, LABELS, LABEL_SPECS, SKIPPED_ITEMS, PRIORITIZED_ITEMS, ALLOWED_REPOS, SELF_REPO, type Repo } from "./config.js";
```

Then add a `filterRepos` helper function after `clearRepoCache()` (after line 118):

```typescript
function filterRepos(repos: Repo[]): Repo[] {
  if (ALLOWED_REPOS === null) return repos;

  const selfRepoShort = SELF_REPO.split("/").pop()!.toLowerCase();
  const allowSet = new Set(ALLOWED_REPOS.map(r => r.toLowerCase()));
  allowSet.add(selfRepoShort);

  // Warn about config entries that don't match any discovered repo
  const discoveredNames = new Set(repos.map(r => r.name.toLowerCase()));
  for (const name of ALLOWED_REPOS) {
    if (!discoveredNames.has(name.toLowerCase()) && name.toLowerCase() !== selfRepoShort) {
      log.warn(`allowedRepos: "${name}" does not match any discovered repository`);
    }
  }

  return repos.filter(r => allowSet.has(r.name.toLowerCase()));
}
```

Then in `listRepos()`, apply the filter before caching. Replace lines 303-318 (from `repoCachePromise = fetchRepos();` through the end of the `finally` block):

```typescript
  repoCachePromise = fetchRepos();
  try {
    const fetched = await repoCachePromise;

    // If the fetch returned empty but we had repos before, a transient error
    // (e.g. rate limit) likely caused all owners to fail. Return stale cache.
    if (fetched.length === 0 && repoCache && repoCache.repos.length > 0) {
      log.warn(`listRepos: fetch returned 0 repos, returning stale cache (${repoCache.repos.length} repos)`);
      return repoCache.repos;
    }

    const repos = filterRepos(fetched);
    repoCache = { repos, fetchedAt: Date.now() };
    return repos;
  } finally {
    repoCachePromise = null;
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/github.test.ts -t "filters to allowed repos plus self-repo"`
Expected: PASS

- [ ] **Step 7: Write test — empty allow-list returns only self-repo**

Add inside `describe("allowedRepos filtering")`:

```typescript
  it("empty allow-list returns only self-repo", async () => {
    (config as any).ALLOWED_REPOS = [];
    const repos = await listRepos();
    expect(repos).toHaveLength(1);
    expect(repos[0].name).toBe("test-repo");
  });
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run src/github.test.ts -t "empty allow-list returns only self-repo"`
Expected: PASS

- [ ] **Step 9: Write test — self-repo included even when not explicitly listed**

Add inside `describe("allowedRepos filtering")`:

```typescript
  it("self-repo included even when not in allow-list", async () => {
    (config as any).ALLOWED_REPOS = ["repo-b"];
    const repos = await listRepos();
    expect(repos.map(r => r.name).sort()).toEqual(["repo-b", "test-repo"]);
  });
```

- [ ] **Step 10: Run the test to verify it passes**

Run: `npx vitest run src/github.test.ts -t "self-repo included even when not in allow-list"`
Expected: PASS

- [ ] **Step 11: Write test — case-insensitive matching**

Add inside `describe("allowedRepos filtering")`:

```typescript
  it("matches repo names case-insensitively", async () => {
    (config as any).ALLOWED_REPOS = ["Repo-A"];
    const repos = await listRepos();
    expect(repos).toHaveLength(2);
    expect(repos.map(r => r.name).sort()).toEqual(["repo-a", "test-repo"]);
  });
```

- [ ] **Step 12: Run the test to verify it passes**

Run: `npx vitest run src/github.test.ts -t "matches repo names case-insensitively"`
Expected: PASS

- [ ] **Step 13: Write test — warning for unknown repo names**

Add inside `describe("allowedRepos filtering")`:

```typescript
  it("warns about allow-list entries that don't match any repo", async () => {
    (config as any).ALLOWED_REPOS = ["nonexistent-repo"];
    await listRepos();
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('"nonexistent-repo" does not match any discovered repository'),
    );
  });
```

- [ ] **Step 14: Run the test to verify it passes**

Run: `npx vitest run src/github.test.ts -t "warns about allow-list entries"`
Expected: PASS

- [ ] **Step 15: Write test — config reload applies new filter**

Add inside `describe("allowedRepos filtering")`:

```typescript
  it("applies new filter after cache clear", async () => {
    (config as any).ALLOWED_REPOS = ["repo-a"];
    const first = await listRepos();
    expect(first).toHaveLength(2);

    // Change config and clear cache
    (config as any).ALLOWED_REPOS = ["repo-b"];
    clearRepoCache();

    const second = await listRepos();
    expect(second).toHaveLength(2);
    expect(second.map(r => r.name).sort()).toEqual(["repo-b", "test-repo"]);
  });
```

- [ ] **Step 16: Run the test to verify it passes**

Run: `npx vitest run src/github.test.ts -t "applies new filter after cache clear"`
Expected: PASS

- [ ] **Step 17: Run all github tests**

Run: `npx vitest run src/github.test.ts`
Expected: All tests PASS

- [ ] **Step 18: Run full test suite**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 19: Commit**

```bash
git add src/github.ts src/github.test.ts
git commit -m "feat: filter listRepos by allowedRepos config with self-repo always included"
```

---

### Task 3: Update deploy/install.sh

**Files:**
- Modify: `deploy/install.sh:76-81` (config template)

- [ ] **Step 1: Add `allowedRepos` to the JSON template**

In `deploy/install.sh`, change line 80 from:

```json
  "prioritizedItems": []
```

to:

```json
  "prioritizedItems": [],
  "allowedRepos": []
```

- [ ] **Step 2: Commit**

```bash
git add deploy/install.sh
git commit -m "feat: add allowedRepos to install.sh bootstrap config"
```

---

### Task 4: Update documentation

**Files:**
- Modify: `README.md:100-112` (config table)
- Modify: `README.md:122-124` (Jobs section intro)
- Modify: `CLAUDE.md` (config.ts module description)

- [ ] **Step 1: Add `allowedRepos` to the README config table**

In `README.md`, add a new row to the "All configuration options" table (after line 111, the `intervals.reviewAddresserMs` row):

```markdown
| `allowedRepos` | `YETI_ALLOWED_REPOS` | *(absent — no filtering)* | Repo short-name allow-list (env var is comma-separated). Self-repo always included. |
```

- [ ] **Step 2: Add migration guide section to README**

In `README.md`, add after the "All configuration options" table (after line 112) and before "### External tool authentication":

```markdown

### Migrating to `allowedRepos`

By default, `allowedRepos` is absent from your config, which means all discovered repos are processed — **no action is required on upgrade**. To restrict which repos Yeti operates on:

1. Add `allowedRepos` to `~/.yeti/config.json` with the short names of repos you want Yeti to manage:

```json
{
  "allowedRepos": ["yeti", "my-app", "docs"]
}
```

2. The self-repo (e.g., `yeti`) is always included implicitly — you don't need to list it, but it's fine if you do.

3. An empty list (`[]`) means only the self-repo gets jobs. To process no repos at all, pause all jobs instead.

4. Repo names are case-insensitive and apply across all configured `githubOwners`.
```

- [ ] **Step 3: Update the Jobs section intro**

In `README.md`, update line 124 from:

```markdown
Yeti runs 10 jobs on timers. Each job scans all repos under the configured `githubOwners`. Understanding what triggers each job is important — **most jobs do not require labels** and will discover work based on PR/issue state.
```

to:

```markdown
Yeti runs 10 jobs on timers. Each job scans repos under the configured `githubOwners`, filtered by `allowedRepos` if set. Understanding what triggers each job is important — **most jobs do not require labels** and will discover work based on PR/issue state.
```

- [ ] **Step 4: Update CLAUDE.md**

In `CLAUDE.md`, in the `config.ts` bullet under "Core modules", update the description from:

```markdown
- **`config.ts`** — Configuration priority: env vars > `~/.yeti/config.json` > defaults. Uses ESM `export let` for live reloads without restart. Exports `LABELS`, `INTERVALS`, `SCHEDULES`, etc.
```

to:

```markdown
- **`config.ts`** — Configuration priority: env vars > `~/.yeti/config.json` > defaults. Uses ESM `export let` for live reloads without restart. Exports `LABELS`, `INTERVALS`, `SCHEDULES`, `ALLOWED_REPOS`, etc.
```

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: document allowedRepos config and migration guide"
```

---

### Task 5: Final verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests PASS

- [ ] **Step 2: Run TypeScript compiler**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Build the project**

Run: `npm run build`
Expected: Build succeeds
