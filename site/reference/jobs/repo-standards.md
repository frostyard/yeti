# repo-standards

> Syncs Yeti's label definitions to all scanned repositories and cleans up the remnants of older seasons.

| Property | Value |
|----------|-------|
| Type | Scheduled |
| Default hour | 2 AM (`schedules.repoStandardsHour`) |
| Uses AI | No |
| Backend | None (pure GitHub API operations) |
| Config key | `schedules.repoStandardsHour` |

## What it does

The repo-standards job ensures that all six Yeti labels exist on every repository Yeti scans, with the correct names, colors, and descriptions. It also cleans up legacy labels from previous versions of Yeti.

This is the simplest job in Yeti's arsenal -- no AI, no worktrees, no complex logic. It just makes sure the signaling infrastructure is in place.

## Trigger

Scheduled to run once daily. Also runs on startup.

## Labels

| Label | Color | Description | Action |
|-------|-------|-------------|--------|
| `Needs Refinement` | `#d876e3` | Issue needs an AI-generated implementation plan | Creates if missing |
| `Needs Plan Review` | `#c5def5` | Plan awaiting adversarial AI review | Creates if missing |
| `Ready` | `#0e8a16` | Yeti has finished -- needs human attention | Creates if missing |
| `Refined` | `#0075ca` | Issue is ready for yeti to implement | Creates if missing |
| `In Review` | `#fbca04` | Issue has an open PR being reviewed | Creates if missing |
| `Priority` | `#d93f0b` | High-priority -- processed first in all Yeti queues | Creates if missing |

## How it works

For each repository in the scan list:

1. **Ensure all labels** -- Creates any missing Yeti labels with the correct color and description. If a label already exists, it is left as-is (colors and descriptions are not forcibly updated)
2. **Delete legacy labels** -- Removes labels from previous versions of Yeti that are no longer used

### Legacy Labels Deleted

The following labels are automatically cleaned up:

- `Plan Produced`
- `Reviewed`
- `prod-report`
- `investigated`
- `yeti-mergeable`
- `yeti-error`

Deletion failures are silently ignored (the label may have already been removed or may never have existed on a given repository).

## Related jobs

All other jobs depend on repo-standards having run at least once to ensure the necessary labels exist on each repository. In practice, this is handled automatically since repo-standards runs on startup.
