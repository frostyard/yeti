# Self-Improvement Loop — Design Spec

**Date:** 2026-07-02
**Status:** Approved design, pending implementation plan
**Inspiration:** [dakota AGENTS.md — The Self-Improvement Loop](https://github.com/projectbluefin/dakota/blob/testing/AGENTS.md#the-self-improvement-loop)

## Problem

Friction discovered during agent runs (workarounds, non-obvious patterns, environment quirks) is discarded when the run ends, so the same friction repeats on every future run. Yeti already has adjacent machinery — prompt-evaluator, triage-yeti-errors, doc-maintainer, hot-reloadable policies — but no loop is closed end-to-end: prompt-evaluator files `prompt-improvement` issues nothing consumes, triage produces reports not policy edits, and `runAI` output (the only place in-run friction is visible) is discarded after use.

## Core principle (from dakota)

Every work session must produce two outputs: the work itself, and the learning derived from it. "Output 1 without Output 2 leaves the system no smarter. The loop only compounds if agents write back." Yeti's twist: it is a daemon, so the write-back is **parsed and mechanically enforced**, not just requested.

## Scope decision

Two friction surfaces, both in scope:

1. **Target-repo knowledge** — patterns discovered while working in a repo, written back into that repo's `yeti/` directory in the same PR as the work (dakota-style, adapted to yeti's existing AI-docs convention).
2. **Yeti-side knowledge** — environment/tooling friction about yeti's own operation ("use brew not apt", "gh needs flag X"), declared by agents, persisted by the daemon, and periodically consolidated into `_preamble.md` / policies via a human-reviewed PR.

## Components

### 1. The mandate — `src/policies/_preamble.md`

Extend the shared preamble (already prepended to every rendered prompt by `renderPolicy()`) with the skill-improvement mandate:

- Before finishing, identify any workaround, non-obvious pattern, convention, or trial-and-error discovery from this session.
- **Write it:** workarounds for upstream bugs (with links), non-obvious patterns required for correctness, non-obvious conventions, trial-and-error discoveries.
- **Don't write it:** one-off task notes, obvious knowledge, ephemeral state. Banned: changelog files, "append here" instructions, session notes.
- Repo-level learnings must be written as files under the target repo's `yeti/` directory (e.g. `yeti/learnings/<slug>.md`) and **committed with the work in the same PR**.
- Every response must end with a machine-readable declaration (both lines always present):

```
LEARNINGS-REPO: none | yeti/learnings/<slug>.md: <one-line summary>
LEARNINGS-YETI: none | <one-line environment/tooling learning>
```

Because most job policies already instruct "read `yeti/OVERVIEW.md` first (and linked docs)", repo learnings land in the next agent's context automatically — no new read-side plumbing.

Note: `_preamble.md` is prepended to **every** rendered prompt, so judge/classifier runs will also see the mandate — but only work jobs enforce and consume the declaration (§2). Structured-output parsers (e.g. `parseJudgment`) extract specific fields, so a trailing declaration is inert there; this is accepted noise in exchange for keeping the mandate in one DRY place.

### 2. The mechanical gate — new `src/learnings.ts`

- `parseLearnings(output: string)` — pure function extracting the declaration. Tolerant of surrounding formatting noise; strict on the `LEARNINGS-REPO:` / `LEARNINGS-YETI:` line prefixes. Returns `{ repo: LearningDecl[], yeti: string[], declared: boolean }`.
- `enforceLearnings(...)` — gate applied after `runAI` in **work jobs only** (issue-worker, ci-fixer, improvement-identifier implement phase, review-addresser). Judges, classifiers, and generators (plan-reviewer verdict, prompt-evaluator internals, ci-fixer classify) are exempt.
  - Declaration missing → re-prompt **once**, in the same worktree, with a short prompt: "your output was missing the Learnings declaration — review your diff and emit it now."
  - `LEARNINGS-REPO` claims a file → verify via the existing tree-diff-guard pattern that `yeti/` paths actually changed in the worktree; mismatch downgrades to `none` with a logged warning.
  - `LEARNINGS-YETI` non-none → insert into the `learnings` DB table.
  - The gate **never fails a task**. After one retry, learnings are best-effort: log, continue, deliver the work.

### 3. Persistence + dashboard — `src/db.ts`, `src/api.ts`, `web/`

New `learnings` table:

| column | type / values |
|---|---|
| `id` | integer PK |
| `job_name` | text |
| `repo` | text |
| `kind` | `repo` \| `yeti` |
| `summary` | text |
| `status` | `pending` \| `consolidated` \| `dismissed` |
| `pr_number` | integer, nullable |
| `created_at` | timestamp |

Per the cross-cutting rules in CLAUDE.md:

- API: `GET /api/learnings` (list, filterable by status), `POST /api/learnings/:id/dismiss`. Extend `GET /api/overview` with pending-learnings count.
- SPA: typed client in `web/src/lib/api.ts`, types in `web/src/lib/types.ts`, query hooks in `web/src/lib/queries.ts`, a Learnings route in `web/src/routes/`, and a pending-learnings card on Overview.

### 4. The consolidator — new `src/jobs/learning-consolidator.ts`

Scheduled job (daily by default; also triggers when the pending count reaches a configurable threshold, default 5). Flow:

1. Read `pending` learnings of kind `yeti`.
2. One AI pass in a SELF_REPO worktree (policy: `src/policies/learning-consolidator.md`): dedup against current `_preamble.md`, job policies, and `yeti/` docs; decide placement per learning (preamble = environment-wide, specific policy = job-scoped, yeti doc = architectural); edit files; commit.
3. Open a PR against the yeti repo listing the source learnings (existing PR-creation patterns: tree-diff guard, fresh duplicate-PR guard).
4. Mark included learnings `consolidated` with the PR number; mark already-covered / non-actionable ones `dismissed` with a reason.
5. Human merges → release flow auto-deploys → every future prompt includes the learning.

Standard job plumbing: listed in `enabledJobs`, interval in `INTERVALS`/config, `deploy/install.sh` + `buildConfigUpdate()` whitelist + `Config.tsx` for any new config fields, error-reporter for failures.

### 5. Anti-staleness — doc-maintainer as composter

Dakota bans append-forever files; yeti's defense is that `yeti/learnings/*.md` are **seeds, not archives**. Update doc-maintainer's policy: fold learnings files into the proper topic docs over time, prune duplicates and stale entries, keep `OVERVIEW.md` linking what remains. The loop writes fast; doc-maintainer curates slow.

## Error handling

- Gate failures (missing declaration after retry, diff mismatch) log a warning and continue — the work output is never blocked.
- Consolidator failures go through the existing error-reporter (`[yeti-error]` flow).
- `parseLearnings` is defensive: malformed declarations are treated as absent, never thrown on.

## Testing (TDD throughout)

- `src/learnings.test.ts` — pure-function tests for `parseLearnings` (present/absent/malformed/multiline declarations), gate behavior with mocked `runAI` (retry-once, tree-diff downgrade, never-fail).
- `src/jobs/learning-consolidator.test.ts` — mocked `gh`/claude per existing patterns (`test-helpers.ts` factories): dedup, placement, PR creation, status transitions.
- `src/db.test.ts` additions — `learnings` table CRUD + migration.
- `web/` tests for the Learnings route and Overview card.

## Cost

Per work run: a few hundred output tokens for the declaration; an occasional single retry call. Consolidator: one AI call per scheduled run. No new external dependencies.

## Out of scope (future work)

- Closing the prompt-evaluator loop: the consolidator pattern could later consume `prompt-improvement` issues and PR the winning prompt variants automatically.
- Persisting full `runAI` transcripts for offline friction mining — declarations-in-output makes this unnecessary for v1.
- Repo-learnings review UI — repo learnings ride the normal PR review flow already.

## Documentation updates required (per CLAUDE.md)

- `CLAUDE.md` — new module (`learnings.ts`), new job, new table, new API routes.
- `yeti/OVERVIEW.md`, `yeti/jobs.md`, `yeti/modules.md`, `yeti/database-schema.md`.
- `README.md` if it lists jobs/features.
