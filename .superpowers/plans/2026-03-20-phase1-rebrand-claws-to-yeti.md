# Phase 1: Rebrand Claws to Yeti — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename all references from "Claws" to "Yeti" across the entire codebase, deploy scripts, docs, and configuration.

**Architecture:** Mechanical find-and-replace in a specific order (longest/most-specific strings first to avoid partial matches), followed by targeted changes for port, org references, and file renames. No behavioral changes.

**Tech Stack:** Node.js 22, TypeScript (strict), ESM, Vitest, systemd

**Spec:** `.superpowers/specs/2026-03-20-phase1-rebrand-claws-to-yeti-design.md`

---

### Task 1: Create Branch and Rename Files

**Files:**
- Rename: `deploy/claws.service` → `deploy/yeti.service`
- Rename: `deploy/claws-updater.service` → `deploy/yeti-updater.service`
- Rename: `deploy/claws-updater.timer` → `deploy/yeti-updater.timer`
- Rename: `src/jobs/triage-claws-errors.ts` → `src/jobs/triage-yeti-errors.ts`
- Rename: `src/jobs/triage-claws-errors.test.ts` → `src/jobs/triage-yeti-errors.test.ts`
- Delete: `yeti/blog-post.md`

- [ ] **Step 1: Create feature branch**

```bash
git checkout -b feat/rebrand-yeti
```

- [ ] **Step 2: Rename deploy files**

```bash
git mv deploy/claws.service deploy/yeti.service
git mv deploy/claws-updater.service deploy/yeti-updater.service
git mv deploy/claws-updater.timer deploy/yeti-updater.timer
```

- [ ] **Step 3: Rename source files**

```bash
git mv src/jobs/triage-claws-errors.ts src/jobs/triage-yeti-errors.ts
git mv src/jobs/triage-claws-errors.test.ts src/jobs/triage-yeti-errors.test.ts
```

- [ ] **Step 4: Delete blog post**

```bash
git rm yeti/blog-post.md
```

- [ ] **Step 5: Commit file renames**

```bash
git add -A
git commit -m "refactor: rename claws files to yeti, delete blog post"
```

---

### Task 2: Global String Replacements in TypeScript Source Files

Apply case-sensitive replacements across all `.ts` files in `src/`. Order matters — replace longer/more-specific strings first to avoid partial matches.

**Files:**
- Modify: All `src/**/*.ts` files (source and test)

**CRITICAL: Replacement order (must be followed exactly):**

1. `St-John-Software/claws` → `frostyard/yeti`
2. `St-John-Software` → `frostyard`
3. `stjohnb` → `frostyard`
4. `CLAWS` → `YETI`
5. `Claws` → `Yeti`
6. `claws` → `yeti`

- [ ] **Step 1: Run ordered replacements on all .ts files**

Run each `sed` command in order. Use `-i` for in-place editing. Target only `src/` to avoid touching docs or deploy scripts (those are separate tasks).

```bash
find src/ -name '*.ts' -exec sed -i 's/St-John-Software\/claws/frostyard\/yeti/g' {} +
find src/ -name '*.ts' -exec sed -i 's/St-John-Software/frostyard/g' {} +
find src/ -name '*.ts' -exec sed -i 's/stjohnb/frostyard/g' {} +
find src/ -name '*.ts' -exec sed -i 's/CLAWS/YETI/g' {} +
find src/ -name '*.ts' -exec sed -i 's/Claws/Yeti/g' {} +
find src/ -name '*.ts' -exec sed -i 's/claws/yeti/g' {} +
```

- [ ] **Step 2: Verify no remaining "claws" references in src/**

```bash
grep -ri 'claws' src/ --include='*.ts'
```

Expected: No output (zero matches). If there are matches, inspect and fix manually.

- [ ] **Step 3: Verify no remaining "St-John" or "stjohnb" references**

```bash
grep -ri 'St-John-Software\|stjohnb' src/ --include='*.ts'
```

Expected: No output.

- [ ] **Step 4: Commit**

```bash
git add src/
git commit -m "refactor: rename all claws references to yeti in source files"
```

---

### Task 3: Remove LEGACY_VISIBLE_HEADER

After the global rename in Task 2, the legacy header constant and its usage need to be fully removed from `src/github.ts`.

**Files:**
- Modify: `src/github.ts`

- [ ] **Step 1: Remove LEGACY_VISIBLE_HEADER constant and its usage**

In `src/github.ts`, find and remove:

1. The `LEGACY_VISIBLE_HEADER` constant declaration (line with `const LEGACY_VISIBLE_HEADER`). After Task 2's rename, the line will read:
   ```typescript
   const LEGACY_VISIBLE_HEADER = "*— Automated by YETI —*";
   ```
   Delete this entire line and its preceding comment.

2. In the `stripYetiMarker` function (formerly `stripClawsMarker`), remove `.replace(LEGACY_VISIBLE_HEADER, "")` from the chain. The function should become:
   ```typescript
   export function stripYetiMarker(body: string): string {
     return body.replace(YETI_COMMENT_MARKER, "").replace(YETI_VISIBLE_HEADER, "").trim();
   }
   ```

- [ ] **Step 2: Verify build compiles**

```bash
npx tsc --noEmit
```

Expected: No errors. If LEGACY_VISIBLE_HEADER was referenced elsewhere, the compiler will flag it.

- [ ] **Step 3: Commit**

```bash
git add src/github.ts
git commit -m "refactor: remove LEGACY_VISIBLE_HEADER (no backward compat needed)"
```

---

### Task 4: Port Change (3000 → 9384)

Targeted replacement of port defaults. Only change port-related occurrences of `3000` — not backoff math, string truncation, timeouts, or protocol versions.

**Files:**
- Modify: `src/config.ts` (port default)
- Modify: `src/server.test.ts` (test config)
- Modify: `deploy/deploy.sh` (port fallback — 3 occurrences on one line)

- [ ] **Step 1: Update port default in config.ts**

In `src/config.ts`, find the port parsing line (after Task 2 renames it will reference `YETI` env vars):

```typescript
  const port = parseInt(
    process.env["PORT"] ?? String(file.port ?? 3000),
    10,
  );
```

Change `3000` to `9384`:

```typescript
  const port = parseInt(
    process.env["PORT"] ?? String(file.port ?? 9384),
    10,
  );
```

- [ ] **Step 2: Update port in server.test.ts**

Find the test config object that sets `port: 3000` and change to `port: 9384`.

- [ ] **Step 3: Update port in deploy/deploy.sh**

Find the line with the port config resolution (contains three occurrences of `3000`). Replace all three with `9384`. The line pattern is:
```bash
CONFIG_PORT=$(node -e "...port||3000)...console.log(3000)}" ... || echo "3000")
```
Change to use `9384` in all three positions.

- [ ] **Step 4: Verify no accidental port changes**

```bash
grep -n '9384' src/config.ts src/server.test.ts deploy/deploy.sh
```

Expected: Exactly the lines you changed (1 in config.ts, 1+ in server.test.ts, 3 in deploy.sh).

```bash
grep -n '3000' src/config.ts
```

Expected: No matches (the only 3000 in config.ts was the port default).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/server.test.ts deploy/deploy.sh
git commit -m "refactor: change default port from 3000 to 9384"
```

---

### Task 5: Deploy Script Renames

Apply replacements to deploy scripts. This includes the `brendan` → `yeti` rename (scoped to deploy/ only) and the org/repo/service name renames.

**Files:**
- Modify: `deploy/deploy.sh`
- Modify: `deploy/install.sh`
- Modify: `deploy/uninstall.sh`
- Modify: `deploy/yeti.service` (already renamed in Task 1)
- Modify: `deploy/yeti-updater.service` (already renamed in Task 1)
- Modify: `deploy/yeti-updater.timer` (already renamed in Task 1)

- [ ] **Step 1: Run ordered replacements on deploy files**

```bash
find deploy/ -type f -exec sed -i 's/St-John-Software\/claws/frostyard\/yeti/g' {} +
find deploy/ -type f -exec sed -i 's/St-John-Software/frostyard/g' {} +
find deploy/ -type f -exec sed -i 's/stjohnb/frostyard/g' {} +
find deploy/ -type f -exec sed -i 's/brendan/yeti/g' {} +
find deploy/ -type f -exec sed -i 's/CLAWS/YETI/g' {} +
find deploy/ -type f -exec sed -i 's/Claws/Yeti/g' {} +
find deploy/ -type f -exec sed -i 's/claws/yeti/g' {} +
```

- [ ] **Step 2: Verify the service file references**

Check that `deploy/yeti.service` now references:
- `User=yeti`
- `Group=yeti`
- `WorkingDirectory=/opt/yeti`
- `ExecStart=/usr/bin/node /opt/yeti/dist/main.js`
- `EnvironmentFile=-/home/yeti/.yeti/env`

```bash
cat deploy/yeti.service
```

- [ ] **Step 3: Verify the updater service references**

```bash
cat deploy/yeti-updater.service
```

Should reference `ExecStart=/opt/yeti/deploy/deploy.sh`.

- [ ] **Step 4: Verify deploy.sh references**

```bash
grep -n 'claws\|Claws\|CLAWS\|brendan\|St-John' deploy/deploy.sh
```

Expected: No output.

- [ ] **Step 5: Verify install.sh references**

```bash
grep -n 'claws\|Claws\|CLAWS\|brendan\|St-John\|stjohnb' deploy/install.sh
```

Expected: No output.

- [ ] **Step 6: Verify uninstall.sh references**

```bash
grep -n 'claws\|Claws\|CLAWS' deploy/uninstall.sh
```

Expected: No output.

- [ ] **Step 7: Commit**

```bash
git add deploy/
git commit -m "refactor: rename deploy scripts from claws/brendan to yeti"
```

---

### Task 6: Documentation Renames

Apply the same ordered replacements to all documentation files, CLAUDE.md, README.md, ANALYSIS.md, and the ideas folder.

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Modify: `ANALYSIS.md`
- Modify: `yeti/OVERVIEW.md`
- Modify: `yeti/jobs.md`
- Modify: `yeti/database-schema.md`
- Modify: `yeti/whatsapp-setup.md`
- Modify: `yeti/refinements/71.doc.md`
- Modify: `ideas/overview.md`, `ideas/features.md`, `ideas/growth.md`, `ideas/rejected.md`

- [ ] **Step 1: Run ordered replacements on docs and markdown files**

```bash
for f in CLAUDE.md README.md ANALYSIS.md; do
  sed -i 's/St-John-Software\/claws/frostyard\/yeti/g' "$f"
  sed -i 's/St-John-Software/frostyard/g' "$f"
  sed -i 's/stjohnb/frostyard/g' "$f"
  sed -i 's/CLAWS/YETI/g' "$f"
  sed -i 's/Claws/Yeti/g' "$f"
  sed -i 's/claws/yeti/g' "$f"
done

find yeti/ -name '*.md' -exec sed -i 's/St-John-Software\/claws/frostyard\/yeti/g' {} +
find yeti/ -name '*.md' -exec sed -i 's/St-John-Software/frostyard/g' {} +
find yeti/ -name '*.md' -exec sed -i 's/stjohnb/frostyard/g' {} +
find yeti/ -name '*.md' -exec sed -i 's/CLAWS/YETI/g' {} +
find yeti/ -name '*.md' -exec sed -i 's/Claws/Yeti/g' {} +
find yeti/ -name '*.md' -exec sed -i 's/claws/yeti/g' {} +

find ideas/ -name '*.md' -exec sed -i 's/Claws/Yeti/g' {} +
find ideas/ -name '*.md' -exec sed -i 's/claws/yeti/g' {} +
find ideas/ -name '*.md' -exec sed -i 's/CLAWS/YETI/g' {} +
```

- [ ] **Step 2: Update port references in docs (3000 → 9384)**

Only change port-related `3000` in docs. These are in CLAUDE.md, README.md, yeti/OVERVIEW.md, and yeti/whatsapp-setup.md.

```bash
# CLAUDE.md - health check port
sed -i 's/port 3000/port 9384/g' CLAUDE.md

# README.md - health check URL and config table
sed -i 's/localhost:3000/localhost:9384/g' README.md
sed -i "s/| \`3000\`/| \`9384\`/g" README.md

# yeti/OVERVIEW.md - config table
sed -i "s/| \`3000\`/| \`9384\`/g" yeti/OVERVIEW.md

# yeti/whatsapp-setup.md - localhost URLs
sed -i 's/localhost:3000/localhost:9384/g' yeti/whatsapp-setup.md
```

- [ ] **Step 3: Update brendan references in docs**

The `brendan` name may appear in ANALYSIS.md and docs in the context of deploy scripts.

```bash
sed -i 's/brendan/yeti/g' ANALYSIS.md
```

Only apply to ANALYSIS.md — other docs reference brendan only in the deploy context which is already covered.

- [ ] **Step 4: Verify no remaining old references**

```bash
grep -ri 'claws\|St-John\|stjohnb' CLAUDE.md README.md ANALYSIS.md yeti/ ideas/
```

Expected: No output (the spec file in .superpowers/ will still contain old references — that's fine, it's the spec documenting the change).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md ANALYSIS.md yeti/ ideas/
git commit -m "refactor: rename all claws references to yeti in documentation"
```

---

### Task 7: Workflow and Package Config Updates

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/ci.yml` (if it contains claws references)
- Modify: `package.json`

- [ ] **Step 1: Update release workflow**

```bash
sed -i 's/claws\.tar\.gz/yeti.tar.gz/g' .github/workflows/release.yml
sed -i 's/claws/yeti/g' .github/workflows/release.yml
```

- [ ] **Step 2: Check CI workflow for claws references**

```bash
grep -n 'claws' .github/workflows/ci.yml
```

If any matches, apply the same sed replacement. If no matches, skip.

- [ ] **Step 3: Update package.json**

Change the `"name"` field from `"claws"` to `"yeti"`:

In `package.json`, replace:
```json
  "name": "claws",
```
with:
```json
  "name": "yeti",
```

- [ ] **Step 4: Update package-lock.json**

The lockfile also contains `"name": "claws"` (lines 2 and 8) and must stay in sync with `package.json` or `npm ci` will fail.

```bash
sed -i 's/"name": "claws"/"name": "yeti"/' package-lock.json
```

- [ ] **Step 5: Commit**

```bash
git add .github/ package.json package-lock.json
git commit -m "refactor: rename package and workflow artifacts to yeti"
```

---

### Task 8: Build Verification

- [ ] **Step 1: Install dependencies**

```bash
npm ci
```

Expected: Clean install with no errors.

- [ ] **Step 2: Run TypeScript compiler**

```bash
npm run build
```

Expected: Compiles with zero errors. If there are errors, they will be from missed renames (e.g., an import path still referencing `triage-claws-errors`). Fix any errors before proceeding.

- [ ] **Step 3: If build errors, fix and re-verify**

Common issues to check:
- Import paths referencing old filenames (`./triage-claws-errors.js` should be `./triage-yeti-errors.js`)
- References to `LEGACY_VISIBLE_HEADER` if not fully removed
- Mismatched constant/function names

After fixing, re-run `npm run build` until clean.

---

### Task 9: Test Verification

- [ ] **Step 1: Run all tests**

```bash
npm test
```

Expected: All tests pass. The test suite should be fully green since this is a rename-only change with no behavioral modifications.

- [ ] **Step 2: If test failures, diagnose and fix**

Common test issues after rename:
- Hardcoded strings in test assertions that weren't caught by sed (unlikely since we did all .ts files)
- Test config objects referencing old port `3000`
- Mock data using old names

Fix any failures and re-run until green.

- [ ] **Step 3: Commit any test fixes**

```bash
git add -A
git commit -m "fix: resolve test failures from rename"
```

Only create this commit if fixes were needed. Skip if tests passed on first run.

---

### Task 10: Final Review and Commit

- [ ] **Step 1: Full grep for any remaining references**

```bash
grep -ri 'claws' --include='*.ts' --include='*.md' --include='*.sh' --include='*.json' --include='*.yml' --include='*.service' --include='*.timer' . | grep -v '.superpowers/' | grep -v 'node_modules/' | grep -v '.git/' | grep -v 'package-lock.json'
```

Expected: No output. Any remaining references need manual fixing.

- [ ] **Step 2: Check for brendan references outside deploy/**

```bash
grep -ri 'brendan' --include='*.ts' --include='*.md' --include='*.json' --include='*.yml' . | grep -v '.superpowers/' | grep -v 'node_modules/' | grep -v '.git/' | grep -v 'package-lock.json'
```

Expected: No output.

- [ ] **Step 3: Check for St-John-Software references**

```bash
grep -ri 'St-John-Software\|stjohnb' . --include='*.ts' --include='*.md' --include='*.sh' --include='*.json' --include='*.yml' | grep -v '.superpowers/' | grep -v 'node_modules/' | grep -v '.git/' | grep -v 'package-lock.json'
```

Expected: No output.

- [ ] **Step 4: Verify build and tests one final time**

```bash
npm run build && npm test
```

Expected: Both pass cleanly.

- [ ] **Step 5: Final commit if any manual fixes were needed**

```bash
git add -A
git commit -m "refactor: final cleanup of remaining claws references"
```

Only create if there were manual fixes. Skip if everything was clean.
