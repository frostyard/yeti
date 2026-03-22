# triage-yeti-errors

> Investigates Yeti's own error reports -- when the yeti stumbles, it picks itself back up and figures out what happened.

| Property | Value |
|----------|-------|
| Type | Interval |
| Default interval | 10 minutes (`intervals.triageYetiErrorsMs`) |
| Uses AI | Yes |
| Backend | Claude (configurable via `jobAi`) |
| Config key | `intervals.triageYetiErrorsMs` |

## What it does

When Yeti encounters errors during operation, the [error-reporter](../configuration.md) creates `[yeti-error]` issues on the `selfRepo`. This job investigates those errors: it deduplicates them, runs Claude to analyze stack traces and source code, determines the root cause, and posts an investigation report.

Only operates on the configured `selfRepo` (default: `frostyard/yeti`).

## Trigger

Open issues on `selfRepo` with titles matching `[yeti-error] <fingerprint>` that do not yet have a `## Yeti Error Investigation Report` comment.

## Labels

This job does not interact with labels directly. However, after a triage report is posted, the [issue-refiner](issue-refiner.md) may then process the issue for planning if it has the `Needs Refinement` label.

## How it works

### Phase 1: Deduplication by Fingerprint

Before investigating, the job deduplicates error issues by their fingerprint (extracted from the title):

1. Groups uninvestigated issues by fingerprint
2. For each fingerprint group:
   - If an existing (already-investigated) issue has the same fingerprint: closes the new issues as duplicates with a comment referencing the canonical issue
   - If multiple new issues share a fingerprint: keeps the oldest, closes the rest as duplicates
3. Also checks "known fingerprints" lists on existing issues (maintained by Phase 2)

### Phase 2: Investigation

For each canonical (non-duplicate) issue:

1. Creates an isolated git worktree of `selfRepo`
2. Parses the error details from the issue body:
   - **Fingerprint:** The error class identifier (e.g., `ci-fixer:merge-conflict`)
   - **Context:** Where the error occurred (e.g., `frostyard/repo#42`)
   - **Timestamp:** When the error occurred
   - **Error text:** The stack trace or error message
3. Maps the fingerprint to likely source files (e.g., `ci-fixer` maps to `src/jobs/ci-fixer.ts`)
4. Builds an investigation prompt that includes:
   - The error details
   - Summaries of other open error issues (for cross-referencing)
   - Instructions to read `yeti/OVERVIEW.md` and linked docs
   - Instructions to read source code and run verification commands
5. Claude investigates: reads the codebase, analyzes the error path, determines root cause
6. Claude's output ends with `RELATED_ISSUES: <numbers or "none">`
7. Posts `## Yeti Error Investigation Report` comment (without the RELATED_ISSUES line)

### Phase 2 Deduplication: By Root Cause

After investigation, if Claude identified related issues:

1. Closes related issues as duplicates with a comment explaining the shared root cause
2. Collects fingerprints from all closed related issues
3. Updates a `### Known Fingerprints` comment on the canonical issue listing all associated fingerprints
4. This fingerprint list is used by Phase 1 in future runs to catch duplicates even when titles differ

### Fingerprint Format

Error fingerprints follow the pattern `<job-name>:<error-type>`. The job name portion is used to suggest which source file to read during investigation. Examples:

- `ci-fixer:merge-conflict`
- `issue-worker:process-issue`
- `github:rate-limit`

### Relationship with Other Jobs

After the triage report is posted, the issue becomes eligible for the [issue-refiner](issue-refiner.md). The refiner will not process `[yeti-error]` issues until they have a triage report, ensuring the error is understood before a fix is planned.

## Related jobs

- [issue-refiner](issue-refiner.md) -- Plans fixes after triage is complete (requires `Needs Refinement` label)
- [issue-worker](issue-worker.md) -- Implements the planned fix
- [issue-auditor](issue-auditor.md) -- Classifies uninvestigated `[yeti-error]` issues as `needs-triage`
