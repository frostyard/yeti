# improvement-identifier

> Scans codebases for meaningful improvements and implements them as PRs -- finding warmth in the details others overlook.

| Property | Value |
|----------|-------|
| Type | Scheduled |
| Default hour | 3 AM (`schedules.improvementIdentifierHour`) |
| Uses AI | Yes |
| Backend | Claude (configurable via `jobAi`) |
| Config key | `schedules.improvementIdentifierHour` |

## What it does

The improvement-identifier runs nightly in two phases: first it analyzes the codebase for improvement opportunities, then it implements each one as a separate pull request. It is conservative by design -- only suggesting high-value changes and skipping anything that duplicates existing issues or PRs.

## Trigger

Scheduled to run once daily. Skips a repository if any improvement PR (`yeti/improve-*`) is already open.

## Labels

This job does not interact with labels.

## How it works

### Phase 1: Analysis

1. Creates an isolated git worktree
2. Fetches all open issue titles and PR titles for deduplication context
3. Instructs Claude to analyze the codebase, reading `yeti/OVERVIEW.md` for architectural context
4. Claude returns a JSON list of improvements, each with a title and detailed body

**What Claude looks for:**

- Code that could be consolidated (duplicate or near-duplicate logic)
- Overcomplicated code that could be simplified
- Dead code or unused exports/dependencies
- Performance issues or inefficiencies
- Security concerns
- Missing error handling at system boundaries
- Stale TODOs or FIXMEs that should be addressed

**What Claude is told to ignore:**

- Stylistic changes
- Comment additions
- Trivial refactors
- Type annotations or docstrings
- Documentation improvements

### Phase 2: Implementation

For each identified improvement (capped at 10 per run):

1. **Deduplication check** -- Searches existing issues and PRs for similar titles. Skips if a match is found
2. Creates a new worktree on branch `yeti/improve-<hex4>`
3. Runs Claude with a focused implementation prompt
4. If changes are produced with actual tree differences, pushes and creates PR titled `refactor: <improvement title>`
5. PR body includes the improvement description and a footer: `*Automated improvement by yeti improvement-identifier*`

### Conservative Design

The improvement-identifier is intentionally conservative:

- "No improvements found" is a perfectly acceptable result
- Suggestions must be specific and actionable with exact file references
- Related improvements are grouped into a single suggestion
- Existing issues and PRs are checked for duplicates before implementation
- Maximum 10 improvements per run prevents overwhelming a repository
- Skips entirely if improvement PRs are already open

## Related jobs

- [auto-merger](auto-merger.md) -- Merges improvement PRs after LGTM
- [ci-fixer](ci-fixer.md) -- Fixes CI failures on improvement PRs
