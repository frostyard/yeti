# Policy Templates — Step 2 Design

**Date:** 2026-07-01
**Status:** Approved
**Depends on:** Step 1 (`feat/policy-templates`, commit `c306bf8`) — `policy.ts` engine, `renderPolicy`/`resolvePolicyPath`/`substitute`/`watchPolicies`, `Autonomy` type, autonomy-suffix resolution, build-copy of `src/policies` → `dist/policies`.

## Goal

Extend the Step 1 policy-template layer so that:

1. Prompts with **conditional / branching structure** (e.g. single-phase vs multi-phase issue-worker) can live in templates.
2. The **remaining ~13 jobs** render their prompts from templates instead of inline TypeScript.
3. Repo **autonomy tier** is a real, live-reloadable configuration knob (not always `"pr"`).
4. Hot-reload is **safe**: a template typo warns loudly instead of silently shipping a broken prompt.

## Non-goals

- No template language / mini-DSL (mustache/handlebars). Conditionals are handled with plain vars + variant files.
- No full 4-tier matrix of policy files. Variants are authored only where behavior genuinely differs.
- Dashboard UI for autonomy editing is out of scope (stretch: a read-only "loaded policies" panel).

## Design decisions (resolved)

| Decision | Choice |
|----------|--------|
| Conditional structure | **A+B**: `"" \| content` vars for small optional inserts; separate variant files for structurally-distinct prompts. No template language. |
| Autonomy source | **Global default + per-repo map** in `config.json`. |
| Variant authoring | **Base + selective variants** — every job gets a base `.md`; autonomy variants only where behavior differs. |
| Bad-template safety | **Warn + continue** on unsubstituted vars; log loaded count on reload. |
| Inline fallbacks | **Removed** after each job is characterized. Bundled defaults + loud throw are the safety net. |

---

## 1. Engine changes (`src/policy.ts`)

### 1a. Variant templates (approach B) — no API change

The variant is encoded in the **template base name**, so the existing resolver handles it for free:

```ts
const template = plan ? "issue-worker.phased" : "issue-worker";
renderPolicy(template, autonomy, vars);
// resolves: issue-worker.phased-full.md -> issue-worker.phased.md
```

The dot is not special to `resolvePolicyPath` — it is part of the base name, and the autonomy suffix is appended after it. **Convention:** `<job>[.<variant>][<-autonomy-suffix>].md`.

### 1b. Missing-var detection (approach: warn + continue)

Detect leftovers from the **template's** placeholder set minus the provided keys — never by scanning the rendered output (a value that legitimately contains `${...}`, e.g. an issue body, must not trigger a false positive).

```ts
// pseudocode
const templateVars = new Set([...template.matchAll(/\$\{(\w+)\}/g)].map(m => m[1]));
const missing = [...templateVars].filter(k => !(k in vars));
if (missing.length) log.warn(`policy ${absPath}: unsubstituted ${missing.map(v => "${"+v+"}").join(", ")}`);
```

`renderPolicy` still returns the rendered string. Missing-var detection is internal; `substitute` stays pure. (Implementation may return `{ text, missing }` from an internal helper and have `renderPolicy` do the logging, so `substitute` remains trivially testable.)

### 1c. Reload validation

On each reload, `watchPolicies` logs `loaded N policies` and warns on any file it fails to read. Per-job var-set validation is **not** possible at reload time (the engine has no registry of each job's vars), so per-render warnings (1b) are the real safety net.

---

## 2. Autonomy configuration (`src/config.ts`)

Add to `ConfigFile`:

```jsonc
{
  "defaultAutonomy": "pr",              // optional, default "pr"
  "autonomy": {                          // optional per-repo overrides, keyed by fullName
    "acme/experimental": "advisory",
    "acme/stable-lib": "automerge"
  }
}
```

- Export `DEFAULT_AUTONOMY` and `AUTONOMY_MAP`, live-reloaded via the existing `onConfigChange` mechanism (same pattern as `JOB_AI`).
- Resolution precedence:

```ts
export function repoAutonomy(repo: Repo): Autonomy {
  return AUTONOMY_MAP[repo.fullName] ?? repo.autonomy ?? DEFAULT_AUTONOMY;
}
```

- Invalid tier values (not one of `advisory | issues | pr | automerge`) → `log.warn` and fall back to `"pr"` at load time.

---

## 3. Job migration (base + selective variants)

Migrate each job's prompt(s) into `src/policies/`:

- **Approach A** for optional inserts: the job builds a `"" | content` string var (e.g. `${CONFLICTS}`, `${COMMENTS}`).
- **Approach B** for structurally-distinct prompts: a variant file selected by the job (e.g. `issue-worker.phased`).

**Per-job procedure (repeatable):**

1. Write a **characterization test** asserting the template render equals the pre-migration inline output for representative inputs (trailing-whitespace-tolerant, as in Step 1's issue-worker tests).
2. Author the base `.md` (and any variant file) using `${VAR}` placeholders.
3. Wire the job to call `renderPolicy` with the vars it already has in scope.
4. **Remove the inline builder** once the characterization test is green.

**Fallbacks:** none retained. Bundled defaults are copied into `dist/policies` at build and are always present in a correct deploy. If a template is genuinely missing, `renderPolicy` throws; the job's existing `try/catch` + `error-reporter` surfaces it loudly. This is preferred over 13× retained inline duplication.

**First target:** `issue-worker` — add `issue-worker.phased.md`, select via `plan ? "issue-worker.phased" : "issue-worker"`, retire the inline multi-phase branch and the single-phase inline fallback added in Step 1.

**Selective variants (author only these initially):** advisory-tier variants for jobs that must not push/merge under a lower autonomy — candidates: `auto-merger-advisory`, `ci-fixer-advisory`. Confirm the exact set during migration; everything else falls back to base.

---

## 4. Testing

- **Per-job characterization tests** — template render == old inline output, incl. the phased variant.
- **Engine tests** — dotted-variant resolution (`job.variant` + autonomy suffix), missing-var set correctness, warn path, reload logging.
- **Config tests** — `repoAutonomy` precedence (map > repo > default), invalid-value fallback to `"pr"`.

All tests run under vitest. Note the pre-existing environment caveat: `src/db.test.ts` fails locally under Node 26 due to a `better-sqlite3` native-ABI mismatch, independent of this work; CI on a clean checkout is unaffected.

---

## 5. Sequencing — two implementation plans

- **Plan A — Foundation** (`.superpowers/plans/…-step2-foundation.md`): §1 engine + §2 autonomy config + their tests. Small, self-contained, unblocks migration.
- **Plan B — Migration** (`.superpowers/plans/…-step2-migration.md`): §3 job-by-job migration (pipeline, one characterization test each) + selective variants. Depends on Plan A.

**Stretch (not planned yet):** read-only dashboard panel listing loaded policies with resolved path + effective tier.

---

## Follow-up (tracked): autonomy enforcement is not yet wired

**Status as of Plan B completion (commit 04c91f3):** `repoAutonomy` is resolved and passed into `renderPolicy`, but it is used **only** to select a template — and no tier-suffixed variant templates exist yet, so every tier (`advisory`/`issues`/`pr`/`automerge`) resolves to the same base template. **No code path consults `repoAutonomy` to gate behavior** (prevent PR creation / push / merge). Real guards remain code-level and tier-unaware (tree-diff guard, auto-merger LGTM check).

**Consequence:** Setting a repo to `advisory` today changes nothing behaviorally — the bot still opens PRs/pushes. The autonomy knob is currently **cosmetic**.

**Do NOT advertise autonomy as behavior-affecting** (docs/dashboard/config UI) until the follow-up lands.

**Follow-up work (a future plan — was Task 12, deliberately deferred):**
1. Author tier-specific variant templates only where prompt wording must differ (e.g. `issue-worker-advisory.md`: "post your proposed fix as a comment; do not open a PR").
2. Add code that consults `repoAutonomy(repo)` to gate side effects per `AgentMode` semantics: advisory → no issues/PRs; issues → issues only; pr → PRs (human merges); automerge → auto-merge on green. This is the piece that makes the knob real; template variants alone would be misleading.
