# Rename docs/ to yeti/

**Date:** 2026-03-20
**Status:** Approved
**Approach:** Mechanical rename of `docs/` → `yeti/` across target repo prompts and Yeti's own project

## Scope

### Target repos (Claude prompts)

All references to `yeti/OVERVIEW.md` and `docs/` paths in Claude prompts become `yeti/OVERVIEW.md` and `yeti/`:

- `src/jobs/doc-maintainer.ts` — prompt paths `docs/` → `yeti/`, `mkdir -p docs` → `mkdir -p yeti`
- `src/jobs/issue-worker.ts` — "read `yeti/OVERVIEW.md`" → "read `yeti/OVERVIEW.md`"
- `src/jobs/issue-refiner.ts` — same
- `src/jobs/improvement-identifier.ts` — same
- `src/jobs/triage-yeti-errors.ts` — same
- `src/jobs/auto-merger.ts` — `f.startsWith("docs/")` → `f.startsWith("yeti/")`

### Test files

- `src/jobs/auto-merger.test.ts` — mock file paths `docs/` → `yeti/`
- `src/jobs/triage-yeti-errors.test.ts` — prompt assertion paths
- `src/claude.test.ts` — mock output referencing `yeti/OVERVIEW.md`

### Yeti's own project

- `git mv docs/ yeti/` — moves all files (OVERVIEW.md, jobs.md, discord-setup.md, whatsapp-setup.md, database-schema.md, refinements/)
- Update references in: CLAUDE.md, README.md, ANALYSIS.md
- Update references in: .superpowers/ specs and plans

### Not changed

- `.superpowers/` directory
- Branch naming (`yeti/docs-*`)
- doc-maintainer job logic (only prompt paths)
