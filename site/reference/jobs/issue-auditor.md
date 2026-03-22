# issue-auditor

> Audits issue labels for drift and inconsistency -- a nightly patrol to keep the trail markers accurate.

| Property | Value |
|----------|-------|
| Type | Scheduled |
| Default hour | 5 AM (`schedules.issueAuditorHour`) |
| Uses AI | No |
| Backend | None (pure GitHub API operations) |
| Config key | `schedules.issueAuditorHour` |

## What it does

The issue-auditor scans all open issues across all repos and verifies that their labels accurately reflect their actual state. It fixes label drift -- situations where an issue's labels have become inconsistent with reality (e.g., a PR was closed but `In Review` was never removed).

After the audit, it sends a Discord notification summarizing all fixes made.

## Trigger

Scheduled to run once daily. No prerequisites other than being enabled.

## Labels

| Label | Action |
|-------|--------|
| `In Review` | Sets (if issue has an open Yeti PR but label is missing) |
| `In Review` | Removes (if issue has no open Yeti PR but label is present) |
| `Ready` | Sets (if issue has a plan with all feedback addressed but label is missing) |
| `Ready` | Sets (if multi-phase issue is stuck -- merged PRs exist but more phases remain without `Refined`) |

## How it works

### Issue Classification

The auditor classifies each open issue into one of six states:

| State | Condition |
|-------|-----------|
| `refined` | Has the `Refined` label (being processed by issue-worker) |
| `in-progress` | Has an open Yeti PR (`yeti/issue-*` or `yeti/improve-*`) |
| `needs-triage` | Is a `[yeti-error]` issue without an investigation report |
| `needs-refinement` | No plan exists, or plan exists with unreacted human feedback |
| `ready` | Plan exists with all feedback addressed |
| `stuck-multi-phase` | Has merged PRs but more phases remain without `Refined` label |

### Fix Rules

Based on the classification, the auditor applies these corrections:

**`In Review` label:**

- If state is `in-progress` and label is missing: **add** `In Review`
- If state is not `in-progress` and label is present: **remove** `In Review`

**`Ready` label:**

- If state is `ready` and label is missing: **add** `Ready`
- If state is `stuck-multi-phase` and `Ready` is missing: **add** `Ready` (flags for human attention)

### Notification

After processing all repos, the auditor sends a Discord notification with a summary of all fixes applied. Example:

> Issue auditor: fixed 3 issue(s) -- added In Review to myorg/repo#42, removed stale In Review from myorg/repo#37, added Ready to stuck multi-phase myorg/repo#25

If no fixes were needed, no notification is sent.

### Unreacted Comment Detection

To determine if an issue needs refinement, the auditor checks for unreacted human comments after the last plan. It uses the same logic as the [issue-refiner](issue-refiner.md):

1. Find the last `## Implementation Plan` comment posted by Yeti
2. Look at all comments after it
3. Skip bot comments and Yeti's own comments
4. Check each comment for a thumbsup reaction from Yeti
5. If any comment lacks a reaction, the issue needs refinement

## Related jobs

- [issue-refiner](issue-refiner.md) -- Handles issues that the auditor identifies as needing refinement
- [issue-worker](issue-worker.md) -- Handles issues the auditor identifies as stuck multi-phase
- [triage-yeti-errors](triage-yeti-errors.md) -- Handles `[yeti-error]` issues the auditor identifies as needing triage
