# Opt-in Repository Allow-List

**Issue:** [#8 — opt-in repositories in the frostyard org](https://github.com/frostyard/yeti/issues/8)

**Goal:** Add a config-driven allow-list so only explicitly listed repositories get jobs run against them.

## Requirements

1. New `allowedRepos` config field — array of short repo names (e.g., `["yeti", "my-app"]`)
2. Self-repo (derived from `SELF_REPO`) is always implicitly included, even if the list is empty
3. Empty list = only self-repo gets jobs
4. **Absent/undefined field = no filtering** — all discovered repos are processed (backward compatible). Only when `allowedRepos` is explicitly set does filtering activate.
5. Live-reloadable — changing the list takes effect on the next `listRepos()` call after cache clear
6. Env var support: `YETI_ALLOWED_REPOS` as comma-separated string
7. Comparison is case-insensitive — both config values and repo names are lowercased before matching
8. Short names apply across all configured `githubOwners` — if two owners have a repo with the same name, both are included

## Approach: Filter in `listRepos()`

Filtering happens in `listRepos()` in `github.ts`, after `fetchRepos()` returns the full org repo list. This is the single gateway for repo discovery — all jobs, the Discord bot, and the WhatsApp handler go through it.

### Why this approach

- Single choke point — zero changes to any job, Discord, or WhatsApp handler
- Consistent with `GITHUB_OWNERS` already being used in the same function to scope discovery
- Cache integration is free — `clearRepoCache()` (already called on config reload) forces re-fetch-and-filter

### Filtering logic

1. If `ALLOWED_REPOS` is `null` (field absent from config), skip filtering entirely — return all repos
2. Build the effective allow-set (lowercased): `ALLOWED_REPOS` union `{shortName(SELF_REPO)}`
3. After `fetchRepos()` returns, keep only repos where `repo.name.toLowerCase()` is in the allow-set
4. Log a warning (once per cache refresh) for any names in `ALLOWED_REPOS` that don't match a discovered repo (typo detection)
5. The filtered list is what gets cached and returned to all consumers

### Self-repo extraction

The self-repo short name is derived from `SELF_REPO` (e.g., `"frostyard/yeti"` → `"yeti"`). This uses a simple split on `/` and takes the last segment.

## Config changes

In `src/config.ts`:

- Add `allowedRepos?: string[]` to `ConfigFile`
- Parse with env var `YETI_ALLOWED_REPOS` (comma-separated), fallback to `file.allowedRepos ?? null`
- `null` means field is absent → no filtering. `[]` means explicit empty list → only self-repo.
- Env var semantics: if `YETI_ALLOWED_REPOS` is set (even to empty string), filtering activates. There is no env-var way to express the `null` (no filtering) state — unset the env var to disable filtering.
- Export as `ALLOWED_REPOS: readonly string[] | null`
- Include in `reloadConfig()`

## Testing

All tests target `listRepos()` in `github.test.ts`:

1. **`null` (absent) — no filtering** — configure `ALLOWED_REPOS` to `null`, assert all repos returned
2. **Filters to allowed repos + self-repo** — configure `ALLOWED_REPOS` to `["repo-a"]`, mock 3 repos from GitHub, assert only `repo-a` and the self-repo are returned
3. **Empty allow-list returns only self-repo** — configure `ALLOWED_REPOS` to `[]`, assert only self-repo returned
4. **Self-repo included even when not in list** — explicitly verify self-repo appears without being listed
5. **Case-insensitive matching** — configure `ALLOWED_REPOS` to `["Repo-A"]`, assert `repo-a` is still included
6. **Warning for unknown repo names** — configure an allow-list entry that doesn't match any discovered repo, assert warning logged
7. **Config reload applies new filter** — change `ALLOWED_REPOS`, clear cache, verify next call returns updated results

## Deployment

Add `allowedRepos` to the bootstrap config template in `deploy/install.sh`, defaulting to `[]`. Fresh installs are conservative — only the self-repo is processed until the admin explicitly opts in other repos.

## Documentation

- Update `CLAUDE.md` to mention `ALLOWED_REPOS` in the `config.ts` module description
- Update `README.md` config table with the new field
- Add a migration guide section to `README.md` explaining the behavior change:
  - **No action required on upgrade** — absent field means no filtering (all repos processed, same as before)
  - To restrict repos, add `allowedRepos` to `~/.yeti/config.json` with the desired short names
  - Self-repo is always included implicitly
  - Example config snippet
- Update `yeti/` docs if config documentation exists there

## Relationship to enabledJobs

The existing `enabledJobs` plan controls which jobs are registered with the scheduler. `allowedRepos` controls which repositories those jobs operate on. They compose: a job must be enabled AND a repo must be allowed for work to happen on that repo.
