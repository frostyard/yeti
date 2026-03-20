# Phase 2: Remove Irrelevant Jobs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove 6 irrelevant jobs and all dead code (config, UI, docs) they leave behind.

**Architecture:** Delete job files, trace dead references back through config/main/server/pages, clean up cross-job dependencies in issue-refiner and issue-auditor, update docs. Single-pass approach — TypeScript compiler catches missed references.

**Tech Stack:** Node.js 22, TypeScript (strict), ESM, Vitest

**Spec:** `.superpowers/specs/2026-03-20-phase2-remove-irrelevant-jobs-design.md`

---

### Task 1: Create Branch and Delete Job Files

**Files:**
- Delete: `src/jobs/idea-suggester.ts`, `src/jobs/idea-suggester.test.ts`
- Delete: `src/jobs/idea-collector.ts`, `src/jobs/idea-collector.test.ts`
- Delete: `src/jobs/triage-kwyjibo-errors.ts`, `src/jobs/triage-kwyjibo-errors.test.ts`
- Delete: `src/jobs/runner-monitor.ts`, `src/jobs/runner-monitor.test.ts`
- Delete: `src/jobs/ubuntu-latest-scanner.ts`, `src/jobs/ubuntu-latest-scanner.test.ts`
- Delete: `src/jobs/email-monitor.ts`, `src/jobs/email-monitor.test.ts`
- Delete: `src/resources/marketing.ts`

- [ ] **Step 1: Create feature branch**

```bash
git checkout -b feat/remove-irrelevant-jobs
```

- [ ] **Step 2: Delete job files and supporting module**

```bash
git rm src/jobs/idea-suggester.ts src/jobs/idea-suggester.test.ts
git rm src/jobs/idea-collector.ts src/jobs/idea-collector.test.ts
git rm src/jobs/triage-kwyjibo-errors.ts src/jobs/triage-kwyjibo-errors.test.ts
git rm src/jobs/runner-monitor.ts src/jobs/runner-monitor.test.ts
git rm src/jobs/ubuntu-latest-scanner.ts src/jobs/ubuntu-latest-scanner.test.ts
git rm src/jobs/email-monitor.ts src/jobs/email-monitor.test.ts
git rm src/resources/marketing.ts
```

- [ ] **Step 3: Remove dead npm dependencies**

`imapflow`, `nodemailer`, and `@types/nodemailer` are only used by `email-monitor.ts`.

```bash
npm uninstall imapflow nodemailer @types/nodemailer
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: delete 6 irrelevant jobs, marketing module, and dead dependencies"
```

---

### Task 2: Clean Up main.ts

Remove imports and scheduler registrations for the 6 deleted jobs.

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Remove imports (lines 16, 21-22, 25-27)**

Remove these 6 import lines from `src/main.ts`:

```typescript
import * as triageKwyjiboErrors from "./jobs/triage-kwyjibo-errors.js";
import * as ideaSuggester from "./jobs/idea-suggester.js";
import * as ideaCollector from "./jobs/idea-collector.js";
import * as runnerMonitor from "./jobs/runner-monitor.js";
import * as ubuntuLatestScanner from "./jobs/ubuntu-latest-scanner.js";
import * as emailMonitor from "./jobs/email-monitor.js";
```

- [ ] **Step 2: Remove job registration blocks from the jobs array**

Remove these 6 job objects from the `jobs` array (lines 139-146, 183-199, 217-239):

- `triage-kwyjibo-errors` block (uses `INTERVALS.triageKwyjiboErrorsMs`)
- `idea-suggester` block (uses `SCHEDULES.ideaSuggesterHour`)
- `idea-collector` block (uses `INTERVALS.ideaCollectorMs`)
- `runner-monitor` block (uses `INTERVALS.runnerMonitorMs`)
- `ubuntu-latest-scanner` block (uses `SCHEDULES.ubuntuLatestScannerHour`)
- `email-monitor` block (uses `INTERVALS.emailMonitorMs`)

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "refactor: remove deleted job imports and registrations from main.ts"
```

---

### Task 3: Clean Up config.ts

Remove all dead configuration: interfaces, properties, env var handling, exports, and reload assignments.

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Remove RunnerHost interface** (lines 43-50)

Delete the entire `RunnerHost` interface and its export.

- [ ] **Step 2: Remove dead ConfigFile properties**

From the `ConfigFile` interface, remove:
- `kwyjiboBaseUrl?: string;`
- `kwyjiboApiKey?: string;`
- `runners?: RunnerHost[];`
- `emailEnabled?: boolean;`
- `emailUser?: string;`
- `emailAppPassword?: string;`
- `emailRecipient?: string;`
- `emailVegBoxSender?: string;`

From `ConfigFile.intervals`, remove:
- `triageKwyjiboErrorsMs?: number;`
- `ideaCollectorMs?: number;`
- `runnerMonitorMs?: number;`
- `emailMonitorMs?: number;`

From `ConfigFile.schedules`, remove:
- `ideaSuggesterHour?: number;`
- `ubuntuLatestScannerHour?: number;`

- [ ] **Step 3: Remove DEFAULT_RUNNERS constant** (lines 100-109)

Delete the entire `DEFAULT_RUNNERS` array.

- [ ] **Step 4: Remove dead code from loadConfig()**

Remove variable assignments for:
- `kwyjiboBaseUrl` and `kwyjiboApiKey` (and their `KWYJIBO_*` env var reads)
- `runners`
- `emailEnabled`, `emailUser`, `emailAppPassword`, `emailRecipient`, `emailVegBoxSender` (and their `YETI_EMAIL_*` env var reads)

From the `intervals` object, remove:
- `triageKwyjiboErrorsMs`
- `ideaCollectorMs`
- `runnerMonitorMs`
- `emailMonitorMs`

From the `schedules` object, remove:
- `ideaSuggesterHour`
- `ubuntuLatestScannerHour`

Remove these from the `return` statement as well.

- [ ] **Step 5: Remove dead exports**

Remove:
- `export let KWYJIBO_BASE_URL`
- `export let KWYJIBO_API_KEY`
- `export let RUNNER_HOSTS`
- `export const EMAIL_ENABLED`
- `export let EMAIL_USER`
- `export let EMAIL_APP_PASSWORD`
- `export let EMAIL_RECIPIENT`
- `export let EMAIL_VEG_BOX_SENDER`

- [ ] **Step 6: Remove dead reloadConfig() assignments**

Remove reload lines for: `KWYJIBO_BASE_URL`, `KWYJIBO_API_KEY`, `RUNNER_HOSTS`, `EMAIL_USER`, `EMAIL_APP_PASSWORD`, `EMAIL_RECIPIENT`, `EMAIL_VEG_BOX_SENDER`.

- [ ] **Step 7: Remove from SENSITIVE_KEYS**

Remove `"kwyjiboApiKey"` and `"emailAppPassword"` from the `SENSITIVE_KEYS` set.

- [ ] **Step 8: Verify build**

```bash
npx tsc --noEmit
```

Expected: Errors pointing to files that still reference removed config (server.ts, pages/config.ts, etc.). These will be fixed in subsequent tasks. But config.ts itself should have no internal errors.

- [ ] **Step 9: Commit**

```bash
git add src/config.ts
git commit -m "refactor: remove dead config for deleted jobs (kwyjibo, runners, email)"
```

---

### Task 4: Clean Up Cross-Job Dependencies

Remove Kwyjibo imports and guard clauses from issue-refiner and issue-auditor.

**Files:**
- Modify: `src/jobs/issue-refiner.ts`
- Modify: `src/jobs/issue-auditor.ts`
- Modify: `src/jobs/issue-refiner.test.ts`
- Modify: `src/jobs/issue-auditor.test.ts`

- [ ] **Step 1: Clean up issue-refiner.ts**

Remove the import line:
```typescript
import { extractGameId, REPORT_HEADER as KWYJIBO_REPORT_HEADER } from "./triage-kwyjibo-errors.js";
```

Remove the guard clause logic that uses `extractGameId()` and `KWYJIBO_REPORT_HEADER` to skip game-related issues. This is a short block that checks if an issue has a game ID and skips it if a Kwyjibo triage report exists.

- [ ] **Step 2: Clean up issue-refiner.test.ts**

Remove:
- The `vi.mock("./triage-kwyjibo-errors.js", ...)` mock
- The `import { extractGameId } from "./triage-kwyjibo-errors.js"` import
- Any test cases that exercise the Kwyjibo guard clause (tests that set up `extractGameId` mock returns)

- [ ] **Step 3: Clean up issue-auditor.ts**

Remove the import line:
```typescript
import { extractGameId, REPORT_HEADER as KWYJIBO_REPORT_HEADER } from "./triage-kwyjibo-errors.js";
```

Remove the guard clause logic that uses `extractGameId()` and `KWYJIBO_REPORT_HEADER` to classify game-ID issues.

- [ ] **Step 4: Clean up issue-auditor.test.ts**

Remove:
- The `vi.mock("./triage-kwyjibo-errors.js", ...)` mock
- The `import { extractGameId } from "./triage-kwyjibo-errors.js"` import
- Any test cases that exercise the Kwyjibo guard clause

- [ ] **Step 5: Commit**

```bash
git add src/jobs/issue-refiner.ts src/jobs/issue-refiner.test.ts src/jobs/issue-auditor.ts src/jobs/issue-auditor.test.ts
git commit -m "refactor: remove kwyjibo dependencies from issue-refiner and issue-auditor"
```

---

### Task 5: Clean Up Server and Config Page

Remove email-monitor import, dead POST /config params, and dead UI sections.

**Files:**
- Modify: `src/server.ts`
- Modify: `src/pages/config.ts`

- [ ] **Step 1: Clean up server.ts**

1. Remove the import:
   ```typescript
   import * as emailMonitor from "./jobs/email-monitor.js";
   ```

2. Remove the `config.EMAIL_ENABLED` import if it's only used for email status (check if used elsewhere first — it's imported via `import * as config`).

3. Replace both `emailMonitor.getEmailStatus()` call sites with the static object. There are two:

   At the `/status` JSON endpoint (~line 475):
   ```typescript
   // Replace:
   email: config.EMAIL_ENABLED
     ? emailMonitor.getEmailStatus()
     : { configured: false, lastCheck: null, lastError: null },
   // With:
   email: { configured: false, lastCheck: null, lastError: null },
   ```

   At the dashboard rendering (~line 507):
   ```typescript
   // Replace:
   config.EMAIL_ENABLED
     ? emailMonitor.getEmailStatus()
     : { configured: false, lastCheck: null, lastError: null },
   // With:
   { configured: false, lastCheck: null, lastError: null },
   ```

4. Remove dead POST `/config` handler params (~lines 327-346):
   ```typescript
   // Remove these lines:
   if (params["kwyjiboBaseUrl"] !== undefined) updates.kwyjiboBaseUrl = params["kwyjiboBaseUrl"];
   if (params["kwyjiboApiKey"] !== undefined) updates.kwyjiboApiKey = params["kwyjiboApiKey"];
   if (params["emailUser"] !== undefined) updates.emailUser = params["emailUser"];
   if (params["emailAppPassword"] !== undefined) updates.emailAppPassword = params["emailAppPassword"];
   if (params["emailRecipient"] !== undefined) updates.emailRecipient = params["emailRecipient"];
   if (params["emailVegBoxSender"] !== undefined) updates.emailVegBoxSender = params["emailVegBoxSender"];

   // Remove entire runners block:
   if (params["runners"] !== undefined) {
     try {
       const parsed = JSON.parse(params["runners"]);
       if (Array.isArray(parsed)) updates.runners = parsed;
     } catch {
       // Invalid JSON — skip silently
     }
   }
   ```

- [ ] **Step 2: Clean up pages/config.ts**

1. Remove from `envMap` object (~lines 20-28):
   ```typescript
   kwyjiboBaseUrl: "KWYJIBO_BASE_URL",
   kwyjiboApiKey: "KWYJIBO_AUTOMATION_API_KEY",
   emailUser: "YETI_EMAIL_USER",
   emailAppPassword: "YETI_EMAIL_APP_PASSWORD",
   emailRecipient: "YETI_EMAIL_RECIPIENT",
   emailEnabled: "YETI_EMAIL_ENABLED",
   ```

2. Remove Kwyjibo HTML form fields (~lines 99-106):
   ```html
   <label for="kwyjiboBaseUrl">Kwyjibo Base URL</label>
   <input ...>
   ${envNote("kwyjiboBaseUrl")}

   <label for="kwyjiboApiKey">Kwyjibo API Key</label>
   <input ...>
   ${envNote("kwyjiboApiKey")}
   <div class="field-note">Leave empty to keep current value</div>
   ```

3. Remove entire Email section (~lines 121-140):
   ```html
   <h2>Email</h2>
   ... (all email inputs through emailVegBoxSender)
   ```

4. Remove entire Runners section (~lines 142-145):
   ```html
   <h2>Runners</h2>
   ... (runner hosts JSON textarea)
   ```

- [ ] **Step 3: Commit**

```bash
git add src/server.ts src/pages/config.ts
git commit -m "refactor: remove dead email/kwyjibo/runner UI and server references"
```

---

### Task 6: Clean Up Test Files

Fix test files that reference removed config or mock deleted modules.

**Files:**
- Modify: `src/server.test.ts`
- Modify: `src/config.test.ts`

- [ ] **Step 1: Clean up server.test.ts**

1. Remove the mock for email-monitor:
   ```typescript
   vi.mock("./jobs/email-monitor.js", ...)
   ```

2. Remove `EMAIL_ENABLED: false` (or similar) from the config mock object.

3. Remove `kwyjiboBaseUrl` and `kwyjiboApiKey` from any mock `getConfigForDisplay` return values.

- [ ] **Step 2: Clean up config.test.ts**

1. Remove `delete process.env["KWYJIBO_AUTOMATION_API_KEY"]` cleanup lines.
2. Remove `delete process.env["KWYJIBO_BASE_URL"]` cleanup lines.
3. Remove `kwyjiboApiKey` from test fixtures.
4. Remove assertions on `display.kwyjiboApiKey`.

- [ ] **Step 3: Commit**

```bash
git add src/server.test.ts src/config.test.ts
git commit -m "refactor: remove dead config/mock references from test files"
```

---

### Task 7: Documentation Updates

Update all docs to remove references to deleted jobs and dead config.

**Files:**
- Modify: `docs/jobs.md`
- Modify: `docs/OVERVIEW.md`
- Modify: `CLAUDE.md`
- Modify: `ANALYSIS.md`
- Modify: `ideas/features.md`

- [ ] **Step 1: Clean up docs/jobs.md**

Remove entire sections for these jobs:
- triage-kwyjibo-errors
- idea-suggester
- idea-collector
- runner-monitor
- ubuntu-latest-scanner

Also remove any exception notes mentioning these jobs.

- [ ] **Step 2: Clean up docs/OVERVIEW.md**

- Remove deleted jobs from the job tree listing
- Update job counts (~16 → ~10)
- Remove deleted jobs from the jobs table
- Remove runner-monitor and ubuntu-latest-scanner from "CI Infrastructure Monitoring" section
- Remove idea-suggester/idea-collector from "Documentation as Context" section
- Remove idea-suggester from "Skip conditions" section
- Remove triage-kwyjibo-errors from the content-based state machine flow diagram
- Update branch naming table (remove branches for deleted jobs)
- Remove config entries: `kwyjiboBaseUrl`, `kwyjiboApiKey`, `runners`, `intervals.triageKwyjiboErrorsMs`, `intervals.ideaCollectorMs`, `intervals.runnerMonitorMs`, `schedules.ideaSuggesterHour`, `schedules.ubuntuLatestScannerHour`

- [ ] **Step 3: Clean up CLAUDE.md**

- Update "~16 jobs" to "~10 jobs" in the architecture description
- Remove references to deleted jobs from the jobs list

- [ ] **Step 4: Clean up ANALYSIS.md**

- Remove references to deleted jobs from the job table
- Remove ImapFlow/Nodemailer from tech stack section
- Update job count heading (~16 → ~10)

- [ ] **Step 5: Clean up ideas/features.md**

- Remove references to `idea-suggester`

- [ ] **Step 6: Commit**

```bash
git add docs/ CLAUDE.md ANALYSIS.md ideas/
git commit -m "docs: remove references to deleted jobs"
```

---

### Task 8: Build, Test, and Final Verification

- [ ] **Step 1: Install dependencies**

```bash
npm ci
```

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: Zero errors. If errors, fix missed references and re-build.

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: All tests pass. If failures, diagnose (likely missed mocks or config references) and fix.

- [ ] **Step 4: Full grep for remaining references to deleted jobs**

```bash
grep -ri 'idea-suggester\|idea-collector\|triage-kwyjibo\|runner-monitor\|ubuntu-latest-scanner\|email-monitor' --include='*.ts' --include='*.md' --include='*.json' --include='*.yml' . | grep -v '.superpowers/' | grep -v 'node_modules/' | grep -v '.git/' | grep -v 'package-lock.json'
```

Expected: No output. Fix any remaining references.

- [ ] **Step 5: Grep for dead config references**

```bash
grep -ri 'KWYJIBO\|RunnerHost\|DEFAULT_RUNNERS\|RUNNER_HOSTS\|EMAIL_ENABLED\|EMAIL_USER\|EMAIL_APP_PASSWORD\|EMAIL_RECIPIENT\|EMAIL_VEG_BOX_SENDER\|emailVegBoxSender\|kwyjiboBaseUrl\|kwyjiboApiKey' --include='*.ts' . | grep -v '.superpowers/' | grep -v 'node_modules/' | grep -v '.git/'
```

Expected: No output. Fix any remaining references.

- [ ] **Step 6: Final build+test**

```bash
npm run build && npm test
```

Expected: Both pass cleanly.

- [ ] **Step 7: Commit any fixes**

```bash
git add -A
git commit -m "fix: clean up remaining references to deleted jobs"
```

Only create this commit if fixes were needed.
