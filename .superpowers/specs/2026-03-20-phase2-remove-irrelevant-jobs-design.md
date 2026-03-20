# Phase 2: Remove Irrelevant Jobs

**Date:** 2026-03-20
**Status:** Approved
**Approach:** Delete jobs + clean all dead code in one pass, verify with build + tests

## Overview

Remove 6 jobs that are irrelevant to the `frostyard` org, along with all supporting modules, configuration, UI elements, and documentation. No behavioral changes to the 10 retained jobs beyond removing Kwyjibo-specific guard clauses from issue-refiner and issue-auditor.

## Jobs to Remove

| Job | Files | Reason |
|-----|-------|--------|
| `idea-suggester` | `src/jobs/idea-suggester.ts`, `src/jobs/idea-suggester.test.ts` | Slack-dependent ideas pipeline |
| `idea-collector` | `src/jobs/idea-collector.ts`, `src/jobs/idea-collector.test.ts` | Slack-dependent ideas pipeline |
| `triage-kwyjibo-errors` | `src/jobs/triage-kwyjibo-errors.ts`, `src/jobs/triage-kwyjibo-errors.test.ts` | Kwyjibo game server integration |
| `runner-monitor` | `src/jobs/runner-monitor.ts`, `src/jobs/runner-monitor.test.ts` | SSH runner management |
| `ubuntu-latest-scanner` | `src/jobs/ubuntu-latest-scanner.ts`, `src/jobs/ubuntu-latest-scanner.test.ts` | Runner usage scanning |
| `email-monitor` | `src/jobs/email-monitor.ts`, `src/jobs/email-monitor.test.ts` | Gmail veg box recipe integration |

**Total: 12 job files deleted.**

## Jobs to Keep (10)

1. `issue-refiner` — analyzes issues, creates implementation plans
2. `issue-worker` — implements Refined issues as PRs
3. `ci-fixer` — fixes CI failures and merge conflicts
4. `review-addresser` — addresses PR review comments
5. `auto-merger` — auto-merges approved/doc/dependabot PRs
6. `repo-standards` — syncs labels across repos
7. `issue-auditor` — reconciles label state daily
8. `doc-maintainer` — auto-updates repo documentation
9. `improvement-identifier` — finds and implements codebase improvements
10. `triage-yeti-errors` — self-diagnoses internal Yeti errors

Plus the WhatsApp handler (event-driven, not a scheduled job).

## Supporting Files to Remove

| File | Reason |
|------|--------|
| `src/resources/marketing.ts` | Only imported by `idea-suggester` |

## Dead Config to Remove from `src/config.ts`

### Interfaces

- `RunnerHost` interface (entire definition)

### ConfigFile Properties

Remove from the `ConfigFile` interface:
- `kwyjiboBaseUrl`, `kwyjiboApiKey`
- `runners`
- `emailEnabled`, `emailUser`, `emailAppPassword`, `emailRecipient`, `emailVegBoxSender`

### Interval Properties

Remove from `ConfigFile.intervals`:
- `triageKwyjiboErrorsMs`
- `ideaCollectorMs`
- `runnerMonitorMs`
- `emailMonitorMs`

### Schedule Properties

Remove from `ConfigFile.schedules`:
- `ideaSuggesterHour`
- `ubuntuLatestScannerHour`

### Constants

- `DEFAULT_RUNNERS` array

### loadConfig() Function

Remove variable assignments and return values for:
- `kwyjiboBaseUrl`, `kwyjiboApiKey` (and `KWYJIBO_BASE_URL`, `KWYJIBO_AUTOMATION_API_KEY` env var reads)
- `runners`
- `emailEnabled`, `emailUser`, `emailAppPassword`, `emailRecipient`, `emailVegBoxSender` (and all `YETI_EMAIL_*` env var reads)
- `triageKwyjiboErrorsMs`, `ideaCollectorMs`, `runnerMonitorMs`, `emailMonitorMs` from intervals
- `ideaSuggesterHour`, `ubuntuLatestScannerHour` from schedules

### Exported Variables

Remove:
- `KWYJIBO_BASE_URL`, `KWYJIBO_API_KEY`
- `RUNNER_HOSTS`
- `EMAIL_ENABLED`, `EMAIL_USER`, `EMAIL_APP_PASSWORD`, `EMAIL_RECIPIENT`, `EMAIL_VEG_BOX_SENDER`

### reloadConfig() Function

Remove reload assignments for all removed exports.

### SENSITIVE_KEYS

Remove `"kwyjiboApiKey"` and `"emailAppPassword"` from the set.

## Cross-Job Dependency Cleanup

### `src/jobs/issue-refiner.ts`

- Remove import: `import { extractGameId, REPORT_HEADER as KWYJIBO_REPORT_HEADER } from "./triage-kwyjibo-errors.js"`
- Remove guard clause logic that uses `extractGameId()` and `KWYJIBO_REPORT_HEADER` to skip game-related issues

### `src/jobs/issue-auditor.ts`

- Remove import: `import { extractGameId, REPORT_HEADER as KWYJIBO_REPORT_HEADER } from "./triage-kwyjibo-errors.js"`
- Remove guard clause logic that uses `extractGameId()` and `KWYJIBO_REPORT_HEADER` to classify game-ID issues

## UI Cleanup

### `src/pages/config.ts`

Remove from `envMap`:
- `kwyjiboBaseUrl: "KWYJIBO_BASE_URL"`
- `kwyjiboApiKey: "KWYJIBO_AUTOMATION_API_KEY"`
- `emailUser: "YETI_EMAIL_USER"`
- `emailAppPassword: "YETI_EMAIL_APP_PASSWORD"`
- `emailRecipient: "YETI_EMAIL_RECIPIENT"`
- `emailEnabled: "YETI_EMAIL_ENABLED"`

Remove HTML form sections:
- Kwyjibo Base URL and API Key input fields
- Entire "Email" section (heading through all email inputs)
- "Runners" section (heading and runner hosts JSON textarea)

### `src/server.ts`

- Remove import: `import * as emailMonitor from "./jobs/email-monitor.js"`
- Replace `emailMonitor.getEmailStatus()` calls with `{ configured: false, lastCheck: null, lastError: null }` in both the `/status` JSON endpoint AND the dashboard rendering endpoint (two separate call sites)
- Remove dead POST `/config` handler params: `kwyjiboBaseUrl`, `kwyjiboApiKey`, `emailUser`, `emailAppPassword`, `emailRecipient`, `emailVegBoxSender`, `runners` parsing block
- Dashboard email status section left as-is (will show "Not configured" which is correct)

## main.ts Cleanup

### Imports to Remove

- `import * as ideaSuggester from "./jobs/idea-suggester.js"`
- `import * as ideaCollector from "./jobs/idea-collector.js"`
- `import * as triageKwyjiboErrors from "./jobs/triage-kwyjibo-errors.js"`
- `import * as runnerMonitor from "./jobs/runner-monitor.js"`
- `import * as ubuntuLatestScanner from "./jobs/ubuntu-latest-scanner.js"`
- `import * as emailMonitor from "./jobs/email-monitor.js"`

### Scheduler Registrations to Remove

Remove the 6 job registration blocks for all removed jobs from the jobs array.

## Test File Cleanup

### `src/server.test.ts`

- Remove `vi.mock("./jobs/email-monitor.js", ...)` mock
- Remove `EMAIL_ENABLED` from config mock
- Remove `kwyjiboBaseUrl` and `kwyjiboApiKey` from mock `getConfigForDisplay` return value

### `src/config.test.ts`

- Remove `KWYJIBO_AUTOMATION_API_KEY` and `KWYJIBO_BASE_URL` env var cleanup lines
- Remove `kwyjiboApiKey` from test fixtures and assertions

### `src/jobs/issue-refiner.test.ts`

- Remove `vi.mock("./triage-kwyjibo-errors.js", ...)` mock
- Remove `import { extractGameId } from "./triage-kwyjibo-errors.js"` import
- Remove any test cases that exercise the Kwyjibo guard clause

### `src/jobs/issue-auditor.test.ts`

- Remove `vi.mock("./triage-kwyjibo-errors.js", ...)` mock
- Remove `import { extractGameId } from "./triage-kwyjibo-errors.js"` import
- Remove any test cases that exercise the Kwyjibo guard clause

## Documentation Cleanup

### `docs/jobs.md`

- Remove entire sections for: triage-kwyjibo-errors, idea-suggester, idea-collector, runner-monitor, ubuntu-latest-scanner
- Remove any exception notes mentioning removed jobs

### `docs/OVERVIEW.md`

- Remove from job tree listing
- Update job counts (~16 → ~10)
- Remove from jobs table
- Remove runner-monitor and ubuntu-latest-scanner from "CI Infrastructure Monitoring" section
- Remove idea-suggester/idea-collector prompt resource injection paragraph
- Update branch naming table (remove branches for removed jobs)
- Remove config entries: `kwyjiboBaseUrl`, `kwyjiboApiKey`, `runners`, `intervals.triageKwyjiboErrorsMs`, `intervals.ideaCollectorMs`, `intervals.runnerMonitorMs`, `schedules.ideaSuggesterHour`, `schedules.ubuntuLatestScannerHour`
- Remove `triage-kwyjibo-errors` from content-based state machine flow diagram
- Remove `idea-suggester` from "Documentation as Context" and "Skip conditions" sections

### `CLAUDE.md`

- Update architecture section to reflect ~10 jobs instead of ~16
- Remove references to removed jobs

### `ANALYSIS.md`

- Remove references to removed jobs in the job table and elsewhere

### `ideas/features.md`

- Remove references to `idea-suggester`

## Scope Boundaries

**In scope:**
- Delete 12 job files + 1 supporting module (13 files)
- Clean all dead config, env vars, UI elements, server references
- Remove cross-job Kwyjibo dependencies from issue-refiner and issue-auditor
- Update all documentation
- Build verification (`npm run build` passes)
- Test verification (`npm test` passes)

**Out of scope:**
- Slack integration (kept as-is for remaining jobs; note: `slackIdeasChannel`, `SLACK_BOT_TOKEN`, and related Slack Bot API functions in `slack.ts` become orphaned — known dead code to clean in a future pass)
- WhatsApp handler (kept, review later — possibly replace with Telegram)
- Discord integration (Phase 3)
- Any behavioral changes to retained jobs (beyond Kwyjibo guard removal)
