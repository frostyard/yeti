# doc-maintainer

> Keeps repository documentation fresh and accurate, updating it while the codebase sleeps.

| Property | Value |
|----------|-------|
| Type | Scheduled |
| Default hour | 1 AM (`schedules.docMaintainerHour`) |
| Uses AI | Yes |
| Backend | Claude (configurable via `jobAi`) |
| Config key | `schedules.docMaintainerHour` |

## What it does

The doc-maintainer runs nightly (and on startup) to ensure the `yeti/` documentation directory stays in sync with the actual codebase. It reads the code, collects implementation plans from recently-closed issues, and uses Claude to create or update documentation optimized for AI consumption.

## Trigger

Scheduled to run once daily. Also runs on startup if the scheduled hour has passed since the last run.

Skips processing when:

- A docs PR (`yeti/docs-*`) is already open for the repo
- No code has changed since the last documentation update (compared by HEAD SHA)
- The repo has not been cloned yet (only processes already-cloned repos)

## Labels

This job does not interact with labels.

## How it works

1. **Check for existing docs PR** -- Skips if any open PR has a `yeti/docs-*` branch
2. **Create worktree** on branch `yeti/docs-<datestamp>-<hex4>`
3. **Ensure CLAUDE.md documentation block** -- Checks that `CLAUDE.md` contains a `## Documentation` section with both required directives (`**update documentation**` and `**yeti/ directory**`). Creates or updates the file if needed. This commit uses a plain message (no `[doc-maintainer]` tag) so the SHA comparison in the next step is unaffected
4. **Check if maintenance is needed** -- Compares HEAD SHA against the last doc-maintainer commit SHA. Skips if unchanged
5. **Collect recently-closed issues** -- Fetches issues closed since the last doc update (or 7 days if no previous update). Extracts implementation plans from their comments
6. **Write temporary plans** -- Up to 10 plans are written to a `.plans/` directory in the worktree (e.g., `.plans/42.md`). Each plan is capped at 5,000 characters
7. **Run Claude** -- Instructs Claude to:
    - Read `yeti/OVERVIEW.md` and linked documents
    - Update documentation to reflect the current code state
    - Extract architectural context from the collected plans
    - Keep `OVERVIEW.md` concise (200-500 lines)
    - Create dedicated docs for complex subsystems
    - Commit with message `docs: update documentation [doc-maintainer]`
8. **Clean up** -- Removes the temporary `.plans/` directory (never committed)
9. **Push and create PR** -- Only if there are actual tree differences. PR titled `docs: update documentation for <repo>`

### Documentation Structure

The doc-maintainer maintains documentation under `yeti/` with this structure:

- **`yeti/OVERVIEW.md`** -- Main entry point: purpose, architecture, key patterns, configuration
- **Dedicated docs** -- Linked from OVERVIEW.md for complex subsystems (e.g., `yeti/database-schema.md`, `yeti/api-design.md`)

This documentation is written for AI consumption -- maximally useful for understanding the codebase when planning and implementing features, not as user-facing guides.

### Auto-merge Path

Doc PRs created by this job are automatically merged by the [auto-merger](auto-merger.md) when:

- All changed files are under `yeti/` or end in `.md`
- CI checks pass or no checks are configured

## Related jobs

- [auto-merger](auto-merger.md) -- Merges the doc PRs this job creates
- [issue-refiner](issue-refiner.md) -- Uses the documentation this job maintains for planning context
- [issue-worker](issue-worker.md) -- Uses the documentation for implementation context
