# Phase 1: Rebrand Claws to Yeti

**Date:** 2026-03-20
**Status:** Approved
**Approach:** Mechanical find-and-replace (single systematic pass with build/test verification)

## Overview

Rename the Claws GitHub automation daemon to Yeti for the `frostyard` GitHub org. This is a pure rebrand — no behavioral changes, no feature additions, no job removals. The codebase, configuration, paths, deploy scripts, docs, and tests all get updated in one pass.

## Naming Conventions

All case variants map directly:

| Old | New |
|-----|-----|
| `claws` | `yeti` |
| `Claws` | `Yeti` |
| `CLAWS` | `YETI` |
| `myclaws` | `yeti` |
| `St-John-Software/claws` | `frostyard/yeti` |
| `stjohnb`, `St-John-Software` | `frostyard` |
| `brendan` (deploy user) | `yeti` |

The visible header in GitHub comments changes from `*— Automated by Claws —*` to `*— Automated by Yeti —*` (mixed case, matching the naming convention).

## Paths & Runtime Artifacts

| Old | New |
|-----|-----|
| `~/.claws/` | `~/.yeti/` |
| `~/.claws/config.json` | `~/.yeti/config.json` |
| `~/.claws/claws.db` | `~/.yeti/yeti.db` |
| `~/.claws/worktrees/` | `~/.yeti/worktrees/` |
| `~/.claws/env` | `~/.yeti/env` |
| `/opt/claws/` | `/opt/yeti/` |

## File Renames

| Old | New |
|-----|-----|
| `deploy/claws.service` | `deploy/yeti.service` |
| `deploy/claws-updater.service` | `deploy/yeti-updater.service` |
| `deploy/claws-updater.timer` | `deploy/yeti-updater.timer` |
| `src/jobs/triage-claws-errors.ts` | `src/jobs/triage-yeti-errors.ts` |
| `src/jobs/triage-claws-errors.test.ts` | `src/jobs/triage-yeti-errors.test.ts` |

## Environment Variables

All `CLAWS_*` env vars become `YETI_*`:

| Old | New |
|-----|-----|
| `CLAWS_SLACK_WEBHOOK` | `YETI_SLACK_WEBHOOK` |
| `CLAWS_SLACK_BOT_TOKEN` | `YETI_SLACK_BOT_TOKEN` |
| `CLAWS_SLACK_IDEAS_CHANNEL` | `YETI_SLACK_IDEAS_CHANNEL` |
| `CLAWS_GITHUB_OWNERS` | `YETI_GITHUB_OWNERS` |
| `CLAWS_SELF_REPO` | `YETI_SELF_REPO` |
| `CLAWS_EMAIL_ENABLED` | `YETI_EMAIL_ENABLED` |
| `CLAWS_EMAIL_USER` | `YETI_EMAIL_USER` |
| `CLAWS_EMAIL_APP_PASSWORD` | `YETI_EMAIL_APP_PASSWORD` |
| `CLAWS_EMAIL_RECIPIENT` | `YETI_EMAIL_RECIPIENT` |
| `CLAWS_AUTH_TOKEN` | `YETI_AUTH_TOKEN` |
| `CLAWS_MAX_CLAUDE_WORKERS` | `YETI_MAX_CLAUDE_WORKERS` |
| `CLAWS_CLAUDE_TIMEOUT_MS` | `YETI_CLAUDE_TIMEOUT_MS` |

`WHATSAPP_ALLOWED_NUMBERS` has no `CLAWS_` prefix — stays as-is.

## Constants & Code Identifiers

### Constants & Variables

| Old | New |
|-----|-----|
| `CLAWS_ATTENTION_CATEGORIES` | `YETI_ATTENTION_CATEGORIES` |
| `CLAWS_COMMENT_MARKER` | `YETI_COMMENT_MARKER` |
| `CLAWS_VISIBLE_HEADER` | `YETI_VISIBLE_HEADER` |
| `LEGACY_VISIBLE_HEADER` | **removed** (no legacy compat needed) |
| `CLAWS_ERROR_REPORT_HEADER` (import alias) | `YETI_ERROR_REPORT_HEADER` |
| `REPORT_HEADER` (value: `"## Claws Error Investigation Report"`) | `"## Yeti Error Investigation Report"` |
| `clawsAttention` (variable) | `yetiAttention` |
| `IMAGE_DIR` (value: `".claws-images"`) | `".yeti-images"` |

### Functions & Interfaces

| Old | New |
|-----|-----|
| `isClawsComment()` | `isYetiComment()` |
| `stripClawsMarker()` | `stripYetiMarker()` |
| `parseClawsError()` | `parseYetiError()` |
| `ClawsErrorDetails` (interface) | `YetiErrorDetails` |

### String Literals & Labels

| Old | New |
|-----|-----|
| `[claws-error]` (label/tag) | `[yeti-error]` |
| `"claws-error"` (config label) | `"yeti-error"` |
| `"claws-mergeable"` (legacy label) | `"yeti-mergeable"` |
| `"<!-- claws-automated -->"` (comment marker value) | `"<!-- yeti-automated -->"` |
| `"*— Automated by Claws —*"` (visible header value) | `"*— Automated by Yeti —*"` |
| `"triage-claws-errors"` (job name) | `"triage-yeti-errors"` |
| All `claws/` branch prefixes | All become `yeti/` prefixes |
| `claws-bot`, `claws-bot[bot]` (test user refs) | `yeti-bot`, `yeti-bot[bot]` |
| `claws_token`, `claws_theme` (cookie names) | `yeti_token`, `yeti_theme` |
| `triageClawsErrorsMs` (config property) | `triageYetiErrorsMs` |
| Label descriptions containing "claws"/"Claws" | Updated to "yeti"/"Yeti" |
| `"Kwyjibo, Claws, GitHub"` (transcription prompt) | `"Kwyjibo, Yeti, GitHub"` |

### Config Property in `config.json`

The `triageClawsErrorsMs` config key becomes `triageYetiErrorsMs`. Any existing `~/.claws/config.json` files would need this key updated — but since this is a fresh fork, no migration is needed.

### Branch Prefixes

All `claws/` branch prefixes become `yeti/`. Known patterns: `claws/issue-`, `claws/plan-`, `claws/investigate-error-`, `claws/investigate-`, `claws/docs-`, `claws/improve-`, `claws/ideas-`, `claws/ideas-collect-`.

### Release Artifacts

| Old | New |
|-----|-----|
| `claws.tar.gz` (release tarball) | `yeti.tar.gz` |

### Import Paths

File renames require updating all import statements that reference them. Known imports of `./triage-claws-errors.js`:
- `src/main.ts`
- `src/jobs/issue-refiner.ts`
- `src/jobs/issue-auditor.ts`
- Corresponding test files

### Mechanical Replace Scope

Beyond the explicitly listed identifiers, **all** inline occurrences of `claws`/`Claws`/`CLAWS` are renamed mechanically — this includes log messages, code comments, user-facing strings, prompt text, HTML page titles, and section headings. The explicit tables above call out identifiers that need special attention; the mechanical pass catches everything else.

The `brendan` replacement is scoped to `deploy/` files only (`.service` file, `install.sh`, `deploy.sh`) — it does not apply project-wide.

## Port & Config Defaults

| Item | Old | New |
|------|-----|-----|
| Default port | `3000` | `9384` |
| Default `githubOwners` | `["stjohnb", "St-John-Software"]` | `["frostyard"]` |
| Default `selfRepo` | `"St-John-Software/claws"` | `"frostyard/yeti"` |
| Install script `REPO` | `"St-John-Software/claws"` | `"frostyard/yeti"` |
| Deploy script `REPO` | `"St-John-Software/claws"` | `"frostyard/yeti"` |
| Service user/group | `brendan` | `yeti` |
| `package.json` name | current value | `yeti` |

**Important:** The number `3000` appears in many non-port contexts (backoff math in whatsapp.ts, string truncation in error-reporter.ts and ci-fixer.ts, UI setTimeout values in queue.ts, test timers in scheduler.test.ts, WhatsApp protocol version). Only the port default in `config.ts`, `deploy.sh` (3 occurrences on one line), docs, and `server.test.ts` change. All other `3000` values stay untouched.

## Documentation

All docs get the mechanical rename — this includes `CLAUDE.md`, `README.md`, `ANALYSIS.md`, `yeti/OVERVIEW.md`, `yeti/jobs.md`, `yeti/database-schema.md`, `yeti/whatsapp-setup.md`, `yeti/refinements/71.doc.md`, the `ideas/` folder, and `.github/workflows/`. Additionally:

- **`LEGACY_VISIBLE_HEADER`** — removed entirely (no backward compat in a fresh fork)
- **`yeti/blog-post.md`** — removed (artifact of original project)
- **`ANALYSIS.md`** — kept and rebranded (contains security recommendations for a later phase)

## Scope Boundaries

**In scope:**
- All renames/rebrands described above (including all source, tests, deploy scripts, docs, ideas/, workflows)
- 5 file renames
- `deploy/uninstall.sh` content updates (no filename change needed)
- Removing `LEGACY_VISIBLE_HEADER` and `yeti/blog-post.md`
- Release tarball rename (`claws.tar.gz` → `yeti.tar.gz`)
- Build verification (`npm run build` passes)
- Test verification (`npm test` passes)

**Out of scope (later phases):**
- Removing irrelevant jobs (Phase 2)
- Discord integration (Phase 3)
- Security hardening (future phase, guided by ANALYSIS.md)
- Slack → Discord migration in error reporter (Phase 3)
- Creating the `frostyard/yeti` GitHub repo or pushing code
