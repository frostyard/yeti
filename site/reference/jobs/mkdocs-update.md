# mkdocs-update

> Updates MkDocs documentation sites to reflect the current state of the codebase.

| Property | Value |
|----------|-------|
| Type | Scheduled |
| Default hour | 4 AM (`schedules.mkdocsUpdateHour`) |
| Uses AI | Yes |
| Backend | Claude (configurable via `jobAi`) |
| Config key | `schedules.mkdocsUpdateHour` |

## What it does

The mkdocs-update job runs daily to keep MkDocs-based documentation sites in sync with source code changes. It uses AI to read recent git history, understand what changed, and update the Markdown files under the MkDocs docs directory accordingly.

## Trigger

Scheduled to run once daily. Also runs on startup if the scheduled hour has passed since the last run.

Skips processing when:

- An open PR with a `yeti/mkdocs-update-*` branch already exists for the repo
- The repo does not have a `mkdocs.yml` or `mkdocs.yaml` file

## Labels

This job does not interact with labels.

## How it works

1. **Check for existing PR** -- Skips if any open PR has a `yeti/mkdocs-update-*` branch
2. **Create worktree** on branch `yeti/mkdocs-update-<datestamp>-<hex4>`
3. **Check for MkDocs config** -- Skips repos without `mkdocs.yml` or `mkdocs.yaml`
4. **Run AI** -- Instructs the AI to:
    - Read `yeti/OVERVIEW.md` for architecture context
    - Read the MkDocs config to understand the docs structure
    - Scan recent git history for source code changes
    - Read changed source files to understand what actually changed
    - Update only Markdown files under the docs directory (and `mkdocs.yml` if nav changes are needed)
    - Commit with message `docs: update mkdocs content [mkdocs-update]`
5. **Push and create PR** -- Only if there are actual tree differences. PR titled `docs: update mkdocs content for <repo>`

### Source of Truth

The AI is instructed that source code is the single source of truth. When documentation conflicts with the code, the code is always right. The AI does not invent features or behaviors -- it only documents what exists.

### Auto-merge Path

MkDocs update PRs created by this job are automatically merged by the [auto-merger](auto-merger.md) when:

- All changed files are under the docs directory or end in `.md`
- CI checks pass or no checks are configured

## Related jobs

- [doc-maintainer](doc-maintainer.md) -- Updates `yeti/` AI-facing documentation (separate from MkDocs user-facing docs)
- [auto-merger](auto-merger.md) -- Merges the docs PRs this job creates
