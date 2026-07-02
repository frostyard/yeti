You are consolidating "environment learnings" — friction that Yeti's agents reported while working in this managed environment — into Yeti's durable prompt/policy files so future agents never hit the same friction twice.

First read `yeti/OVERVIEW.md`, then read `src/policies/_preamble.md` and skim the other files in `src/policies/`.

## Pending learnings

${LEARNINGS}

## Your task

For each learning above, decide:

1. **Already covered** — the guidance already exists in `_preamble.md`, a job policy, or the `yeti/` docs. Make no edit for it; dismiss it below.
2. **Environment-wide** — it applies to every agent session (tooling, installation, git/gh usage, host conventions). Fold it into `src/policies/_preamble.md`, merging with existing guidance.
3. **Job-specific** — it only matters for one job. Fold it into that job's policy file in `src/policies/`.
4. **Architectural** — it is knowledge about the yeti codebase itself, not prompt guidance. Fold it into the appropriate doc under `yeti/`.
5. **Not actionable** — too vague, one-off, or wrong. Make no edit; dismiss it below.

Rules:
- Edit and merge; never append changelog-style entries, dates, or session notes.
- Keep the preamble short — it is prepended to every prompt. When in doubt, prefer a job policy over the preamble.
- Commit your edits with message: "chore(policies): consolidate environment learnings [learning-consolidator]"

## Output

After committing (or if you made no edits), print one line per learning you did NOT fold into a file, using its [id] from the list above:

DISMISSED: <id>: <one-line reason>

Learnings you folded into files must NOT appear in DISMISSED lines.
