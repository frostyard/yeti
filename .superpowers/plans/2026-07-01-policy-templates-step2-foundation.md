# Policy Templates Step 2 — Plan A (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add template-variant support, unsubstituted-var warnings, reload logging, and live-reloadable per-repo autonomy configuration to the policy-template engine.

**Architecture:** Extends the Step 1 `src/policy.ts` engine (pure `${VAR}` replacer + suffix-based file resolution) and `src/config.ts` (flat parse + `reloadConfig`/`onConfigChange` live-reload). No new dependencies, no template language. Template variants ride on the existing resolver via dotted base names (`job.variant`). Autonomy is resolved from a global default plus a per-repo map.

**Tech Stack:** TypeScript 6 (ESM, Node16 modules), Vitest 4, Node 22+ runtime.

## Global Constraints

- Node runtime: 22 (ESM). Import sibling modules with the `.js` extension.
- `Autonomy` type is owned by `src/policy.ts`; `src/config.ts` imports it **type-only** to avoid a runtime import cycle (`policy.ts` imports `WORK_DIR` from `config.ts` at module top level).
- The four autonomy tiers are exactly: `advisory`, `issues`, `pr`, `automerge`. Default is `pr`.
- `substitute()` must stay pure (no logging, no IO) — it is the trivially-testable core.
- Missing-var detection compares the **template's** placeholders against provided keys — never scan rendered output (a value may legitimately contain `${...}`).
- Tests live beside source as `*.test.ts`. Run a single file with `npx vitest run <path>`.
- Known-good baseline: `src/db.test.ts` fails locally under Node 26 (`better-sqlite3` native-ABI) — unrelated to this work. Verify your tasks with the specific test files named in each task, not the whole suite.

---

### Task 1: Template variant resolution + unsubstituted-var warnings

**Files:**
- Modify: `src/policy.ts`
- Test: `src/policy.test.ts`

**Interfaces:**
- Consumes (existing, Step 1): `resolvePolicyPath(job: string, autonomy: Autonomy, dirs: string[]): string | null`, `renderPolicy(job, autonomy, vars, opts?)`, `substitute(template, vars)`.
- Produces: `findMissingVars(template: string, vars: Record<string, string>): string[]` — returns the distinct `${VAR}` names present in `template` but absent from `vars`, in first-seen order.

- [ ] **Step 1: Write the failing test for `findMissingVars`**

Add to `src/policy.test.ts` (and add `findMissingVars` to the existing import from `./policy.js`):

```ts
import { substitute, resolvePolicyPath, renderPolicy, findMissingVars } from "./policy.js";

describe("findMissingVars", () => {
  it("returns template placeholders not present in vars, distinct and in order", () => {
    expect(findMissingVars("${A} ${B} ${A} ${C}", { A: "1" })).toEqual(["B", "C"]);
  });

  it("returns [] when every placeholder is provided", () => {
    expect(findMissingVars("${A}-${B}", { A: "1", B: "2" })).toEqual([]);
  });

  it("does not flag ${...} that appears only inside a provided value", () => {
    // BODY is provided, so even though its value contains ${X}, X is not a template placeholder
    expect(findMissingVars("body=${BODY}", { BODY: "see ${X}" })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/policy.test.ts`
Expected: FAIL — `findMissingVars is not a function` (not exported yet).

- [ ] **Step 3: Implement `findMissingVars` and wire it into `renderPolicy`**

In `src/policy.ts`, add the helper after `substitute`:

```ts
/**
 * Distinct ${VAR} names present in `template` but absent from `vars`, in
 * first-seen order. Compares against the TEMPLATE's placeholders, not the
 * rendered output, so a value that itself contains ${...} is never flagged.
 */
export function findMissingVars(template: string, vars: Record<string, string>): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const m of template.matchAll(/\$\{(\w+)\}/g)) {
    const key = m[1];
    if (!(key in vars) && !seen.has(key)) {
      seen.add(key);
      missing.push(key);
    }
  }
  return missing;
}
```

Then in `renderPolicy`, after resolving `absPath` and reading the template, warn on leftovers. Replace the existing render body:

```ts
  const template = read(absPath);
  const missing = findMissingVars(template, vars);
  if (missing.length) {
    log.warn(`policy ${absPath}: unsubstituted ${missing.map((v) => "${" + v + "}").join(", ")}`);
  }
  return substitute(template, vars);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/policy.test.ts`
Expected: PASS (all `findMissingVars` cases plus the existing Step 1 tests).

- [ ] **Step 5: Write the failing test for dotted-variant resolution**

Add to the `resolvePolicyPath` describe block in `src/policy.test.ts`:

```ts
  it("resolves a dotted variant name with the autonomy suffix", () => {
    fs.writeFileSync(path.join(dirA, "issue-worker.phased.md"), "base");
    fs.writeFileSync(path.join(dirA, "issue-worker.phased-full.md"), "full");
    expect(resolvePolicyPath("issue-worker.phased", "pr", [dirA])).toBe(
      path.join(dirA, "issue-worker.phased-full.md"),
    );
  });

  it("falls back to the dotted base when the suffixed variant is absent", () => {
    fs.writeFileSync(path.join(dirA, "issue-worker.phased.md"), "base");
    expect(resolvePolicyPath("issue-worker.phased", "advisory", [dirA])).toBe(
      path.join(dirA, "issue-worker.phased.md"),
    );
  });
```

- [ ] **Step 6: Run the test to verify it passes immediately (regression guard)**

Run: `npx vitest run src/policy.test.ts`
Expected: PASS. `resolvePolicyPath` already treats the dotted name as the base and appends the suffix — these tests lock that convention against future regressions. (`pr` → suffix `-full`.)

- [ ] **Step 7: Commit**

```bash
git add src/policy.ts src/policy.test.ts
git commit -m "feat(policy): variant-name resolution guard + unsubstituted-var warnings"
```

---

### Task 2: Reload logging for loaded policy count

**Files:**
- Modify: `src/policy.ts`
- Test: `src/policy.test.ts`

**Interfaces:**
- Consumes: `defaultPolicyDirs(): string[]` (existing).
- Produces: `countPolicyFiles(dirs: string[]): number` — number of distinct `.md` files across `dirs` (a filename appearing in multiple dirs counts once, since the earlier dir shadows the later).

- [ ] **Step 1: Write the failing test**

Add to `src/policy.test.ts`:

```ts
import { countPolicyFiles } from "./policy.js";

describe("countPolicyFiles", () => {
  it("counts distinct .md files across dirs, ignoring non-md and shadowed duplicates", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "yeti-count-a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "yeti-count-b-"));
    fs.writeFileSync(path.join(a, "scanner.md"), "");
    fs.writeFileSync(path.join(a, "notes.txt"), "");
    fs.writeFileSync(path.join(b, "scanner.md"), ""); // shadowed by a/scanner.md
    fs.writeFileSync(path.join(b, "ci-fixer.md"), "");
    expect(countPolicyFiles([a, b])).toBe(2); // scanner + ci-fixer
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  });

  it("returns 0 for dirs that do not exist", () => {
    expect(countPolicyFiles(["/no/such/dir-xyz"])).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/policy.test.ts`
Expected: FAIL — `countPolicyFiles is not a function`.

- [ ] **Step 3: Implement `countPolicyFiles` and log on reload**

In `src/policy.ts` add:

```ts
/** Number of distinct <name>.md policy files across dirs (earlier dirs shadow later). */
export function countPolicyFiles(dirs: string[]): number {
  const names = new Set<string>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue; // dir absent — skip
    }
    for (const e of entries) {
      if (e.endsWith(".md")) names.add(e);
    }
  }
  return names.size;
}
```

Then update the debounced reload in `watchPolicies` to log the count. Replace the `setTimeout` body:

```ts
    timer = setTimeout(() => {
      cache.clear();
      log.info(`Policies reloaded (${countPolicyFiles(defaultPolicyDirs())} loaded)`);
    }, 500);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/policy.ts src/policy.test.ts
git commit -m "feat(policy): log loaded policy count on hot-reload"
```

---

### Task 3: Autonomy configuration (global default + per-repo map)

**Files:**
- Modify: `src/config.ts`
- Test: `src/config.test.ts`

**Interfaces:**
- Consumes: `type Autonomy` from `./policy.js` (type-only), existing `Repo` interface, `loadConfig`/`reloadConfig` internals.
- Produces:
  - `export let DEFAULT_AUTONOMY: Autonomy` — the instance default (`"pr"` unless configured).
  - `export let AUTONOMY_MAP: Readonly<Record<string, Autonomy>>` — per-repo overrides keyed by `fullName`.
  - `repoAutonomy(repo: Repo): Autonomy` — precedence `AUTONOMY_MAP[repo.fullName] ?? repo.autonomy ?? DEFAULT_AUTONOMY`.

- [ ] **Step 1: Write the failing test**

Note: `src/config.test.ts` already redirects `WORK_DIR` to a temp dir and writes `config.json` before importing config (see its top-of-file setup). Follow the file's existing helper pattern for writing config and re-importing. Add:

```ts
import { repoAutonomy, DEFAULT_AUTONOMY, AUTONOMY_MAP } from "./config.js";

// Minimal repo factory for these tests
const repo = (fullName: string, autonomy?: string) => ({
  owner: fullName.split("/")[0],
  name: fullName.split("/")[1],
  fullName,
  defaultBranch: "main",
  ...(autonomy ? { autonomy } : {}),
}) as unknown as import("./config.js").Repo;

describe("autonomy config", () => {
  it("defaults DEFAULT_AUTONOMY to 'pr' when unset", () => {
    expect(DEFAULT_AUTONOMY).toBe("pr");
  });

  it("repoAutonomy precedence: map > repo field > default", () => {
    // With no config, map is empty -> falls back to repo field, then default
    expect(repoAutonomy(repo("acme/plain"))).toBe("pr");
    expect(repoAutonomy(repo("acme/withfield", "advisory"))).toBe("advisory");
    // AUTONOMY_MAP is authoritative when present for a fullName
    if (AUTONOMY_MAP["acme/mapped"]) {
      expect(repoAutonomy(repo("acme/mapped", "advisory"))).toBe(AUTONOMY_MAP["acme/mapped"]);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/config.test.ts`
Expected: FAIL — `DEFAULT_AUTONOMY`/`AUTONOMY_MAP`/`repoAutonomy` not exported (or `repoAutonomy` still ignores the map).

- [ ] **Step 3: Add `ConfigFile` fields and parse+validate in `loadConfig`**

In `src/config.ts`, add to the `ConfigFile` interface (near `jobAi?`):

```ts
  defaultAutonomy?: Autonomy;
  autonomy?: Record<string, Autonomy>;
```

Add a module-level validator (near the top of the file, after imports):

```ts
const AUTONOMY_TIERS = ["advisory", "issues", "pr", "automerge"] as const;

function coerceAutonomy(value: unknown, context: string): Autonomy {
  if (typeof value === "string" && (AUTONOMY_TIERS as readonly string[]).includes(value)) {
    return value as Autonomy;
  }
  if (value !== undefined) {
    console.warn(`[WARN] invalid autonomy "${String(value)}" for ${context} — using "pr"`);
  }
  return "pr";
}
```

In `loadConfig`, near the `const jobAi = file.jobAi ?? {};` line, add:

```ts
  const defaultAutonomy = coerceAutonomy(file.defaultAutonomy ?? "pr", "defaultAutonomy");
  const autonomy: Record<string, Autonomy> = {};
  for (const [repo, tier] of Object.entries(file.autonomy ?? {})) {
    autonomy[repo] = coerceAutonomy(tier, `autonomy["${repo}"]`);
  }
```

Add `defaultAutonomy, autonomy` to the object returned at the end of `loadConfig` (the big `return { ... }`).

- [ ] **Step 4: Add exports and reload wiring**

Add exports near `export let JOB_AI`:

```ts
export let DEFAULT_AUTONOMY: Autonomy = config.defaultAutonomy;
export let AUTONOMY_MAP: Readonly<Record<string, Autonomy>> = config.autonomy;
```

In `reloadConfig`, near `JOB_AI = fresh.jobAi;`, add:

```ts
  DEFAULT_AUTONOMY = fresh.defaultAutonomy;
  AUTONOMY_MAP = fresh.autonomy;
```

- [ ] **Step 5: Update `repoAutonomy` to use the map + default**

Replace the Step 1 `repoAutonomy`:

```ts
/** Resolve the autonomy tier for a repo: per-repo map > repo field > instance default. */
export function repoAutonomy(repo: Repo): Autonomy {
  return AUTONOMY_MAP[repo.fullName] ?? repo.autonomy ?? DEFAULT_AUTONOMY;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/config.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: exit 0 (confirms no import-cycle/type breakage from the new fields).

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat(config): live-reloadable per-repo autonomy (default + map)"
```

---

## Self-Review

**Spec coverage:**
- §1a variant templates → Task 1 (Steps 5–6 lock the dotted-name convention; no engine change needed).
- §1b missing-var detection → Task 1 (Steps 1–4).
- §1c reload validation → Task 2.
- §2 autonomy config → Task 3.
- §4 engine + config tests → covered in each task's test steps.
- §3 job migration, §5 dashboard stretch → **not in this plan** (Plan B / stretch), by design.

**Placeholder scan:** none — all steps contain concrete code and exact commands.

**Type consistency:** `findMissingVars`, `countPolicyFiles`, `repoAutonomy`, `DEFAULT_AUTONOMY`, `AUTONOMY_MAP` names are used identically across tasks and match the spec. `Autonomy` remains owned by `policy.ts`; `config.ts` uses a local `AUTONOMY_TIERS` runtime list to avoid a runtime import cycle (only the type is imported from `policy.ts`).
