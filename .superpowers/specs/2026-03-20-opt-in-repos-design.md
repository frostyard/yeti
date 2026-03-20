# Opt-in Repository Allow-List

**Issue:** [#8 — opt-in repositories in the frostyard org](https://github.com/frostyard/yeti/issues/8)

**Goal:** Add a config-driven allow-list so only explicitly listed repositories get jobs run against them.

## Requirements

1. New `allowedRepos` config field — array of short repo names (e.g., `["yeti", "my-app"]`)
2. Self-repo (derived from `SELF_REPO`) is always implicitly included, even if the list is empty
3. Empty list = only self-repo gets jobs
4. Live-reloadable — changing the list takes effect on the next `listRepos()` call after cache clear
5. Env var support: `YETI_ALLOWED_REPOS` as comma-separated string

## Approach: Filter in `listRepos()`

Filtering happens in `listRepos()` in `github.ts`, after `fetchRepos()` returns the full org repo list. This is the single gateway for repo discovery — all jobs, the Discord bot, and the WhatsApp handler go through it.

### Why this approach

- Single choke point — zero changes to any job, Discord, or WhatsApp handler
- Consistent with `GITHUB_OWNERS` already being used in the same function to scope discovery
- Cache integration is free — `clearRepoCache()` (already called on config reload) forces re-fetch-and-filter

### Filtering logic

1. Build the effective allow-set: `ALLOWED_REPOS` union `{shortName(SELF_REPO)}`
2. After `fetchRepos()` returns, keep only repos where `repo.name` is in the allow-set
3. Log a warning for any names in `ALLOWED_REPOS` that don't match a discovered repo (typo detection)
4. The filtered list is what gets cached and returned to all consumers

### Self-repo extraction

The self-repo short name is derived from `SELF_REPO` (e.g., `"frostyard/yeti"` → `"yeti"`). This uses a simple split on `/` and takes the last segment.

## Config changes

In `src/config.ts`:

- Add `allowedRepos?: string[]` to `ConfigFile`
- Parse with env var `YETI_ALLOWED_REPOS` (comma-separated), fallback to `file.allowedRepos ?? []`
- Export as `ALLOWED_REPOS: readonly string[]`
- Include in `reloadConfig()`

## Testing

All tests target `listRepos()` in `github.test.ts`:

1. **Filters to allowed repos + self-repo** — configure `ALLOWED_REPOS` to `["repo-a"]`, mock 3 repos from GitHub, assert only `repo-a` and the self-repo are returned
2. **Empty allow-list returns only self-repo** — configure `ALLOWED_REPOS` to `[]`, assert only self-repo returned
3. **Self-repo included even when not in list** — explicitly verify self-repo appears without being listed
4. **Warning for unknown repo names** — configure an allow-list entry that doesn't match any discovered repo, assert warning logged
5. **Config reload applies new filter** — change `ALLOWED_REPOS`, clear cache, verify next call returns updated results

## Deployment

Add `allowedRepos` to the bootstrap config template in `deploy/install.sh`, defaulting to `[]`.

## Documentation

- Update `CLAUDE.md` to mention `ALLOWED_REPOS` in the `config.ts` module description
- Update `README.md` config table with the new field
- Add a migration guide section to `README.md` explaining the behavior change
- Update `yeti/` docs if config documentation exists there

## Relationship to enabledJobs

The existing `enabledJobs` plan controls which jobs are registered with the scheduler. `allowedRepos` controls which repositories those jobs operate on. They compose: a job must be enabled AND a repo must be allowed for work to happen on that repo.
