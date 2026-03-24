# Jobs

Most jobs follow the same lifecycle:

1. List target issues/PRs via `gh` CLI
2. For each item: record task in DB, create a git worktree, run Claude via the
   serial queue, push results, clean up worktree, update DB
3. Errors are caught per-item (one failure doesn't block processing of other
   items) and reported via `error-reporter.ts`

Exceptions: `auto-merger` and `repo-standards` do not invoke Claude or create
worktrees.

## issue-refiner

**Source**: `src/jobs/issue-refiner.ts`
**Trigger**: Open issues discovered via comment analysis
**Interval**: 5 minutes

Scans all open issues per repo. For each issue, determines state by analysing
comments and reactions — no trigger labels required.

**Skip conditions:**
- Issue has the `Refined` label (being implemented)
- `[yeti-error]` issues without a triage report comment
- Game-ID issues without a triage report comment

Issues without a body are still processed — the prompt uses "(No description
provided)" as a fallback, allowing Claude to plan from the title alone.

Three modes:

### Fresh planning (no plan comment exists)

- Creates a worktree on branch `yeti/plan-<N>-<hex4>`
- Asks Claude for a fresh implementation plan
- **Clarifying questions**: Before planning, Claude evaluates whether the issue
  provides enough detail. If the issue is underspecified (ambiguous behavior,
  unclear scope, missing acceptance criteria), Claude outputs a
  `### Clarifying Questions` section with targeted questions instead of guessing.
  The user responds as a comment on the issue, and the existing refinement loop
  incorporates their answers into a focused plan on the next cycle.
- Posts the plan as a comment prefixed with `## Implementation Plan`
- If `plan-reviewer` is in `enabledJobs`: adds `Needs Plan Review` label (triggers adversarial review)
- Otherwise: adds the `Ready` label (signals "Yeti is done, your turn")

### Refinement (unreacted human comments after plan)

- Finds human comments posted after the latest plan comment
- Checks each comment for a 👍 reaction from Yeti (tracked items)
- If unreacted comments exist, creates a worktree on branch `yeti/plan-<N>-<hex4>`
- Asks Claude to produce an updated plan addressing the feedback
- **Edits the original plan comment in-place** (rather than posting a new one),
  keeping context concise as plans are refined iteratively
- Reacts 👍 to each addressed comment
- If `plan-reviewer` is in `enabledJobs`: adds `Needs Plan Review` label (re-triggers adversarial review)
- Otherwise: re-adds the `Ready` label
- If no plan comment is found (e.g. it was deleted), falls back to posting a
  fresh plan comment

### Follow-up response (issue has an open PR)

When an issue has an open PR (implementation in progress), the refiner checks
for unreacted human comments posted after the plan. If found:

- Creates a worktree so Claude can read the repo for context
- Asks Claude to respond to the follow-up questions (not produce a new plan)
- Posts Claude's response as a **new comment** (does not edit the plan)
- Reacts 👍 to each addressed comment
- Does **not** change labels (the issue is already in implementation)

The `findUnreactedHumanComments()` helper (shared with the refinement flow)
filters out Yeti-authored comments (via marker) and bot comments, then checks
each for a 👍 reaction from Yeti. This prevents infinite response loops since
Yeti's own responses are filtered out on the next pass.

To iterate on a plan: post feedback comments on the issue. The refiner will
detect unreacted comments and update its plan. Repeat until satisfied, then add
`Refined` to trigger implementation.

All prompts instruct Claude to read `yeti/OVERVIEW.md` first if it exists.
Images embedded in issue bodies are downloaded and provided to Claude for
visual context.

## plan-reviewer

**Source**: `src/jobs/plan-reviewer.ts`
**Trigger**: Issues labelled `Needs Plan Review`
**Interval**: 10 minutes

Adversarial review job that critiques implementation plans using a configurable
AI backend (defaults to the backend specified in `jobAi["plan-reviewer"]`).
Designed for cross-AI adversarial review — e.g. Claude produces the plan,
Copilot (or Gemini via Copilot) critiques it.

- Scans open issues with the `Needs Plan Review` label
- Skips issues with the `Refined` label (being implemented)
- Finds the most recent `## Implementation Plan` comment
- Skips if the plan comment already has a 👍 reaction from Yeti (already reviewed)
- Creates a worktree for codebase context
- Uses the configured backend/model from `JOB_AI["plan-reviewer"]` (uses `enqueueCopilot` for copilot, `enqueueCodex` for codex, `enqueue` for claude)
- Posts review as a comment prefixed with `## Plan Review`
- Reacts 👍 to the plan comment (marks as processed)
- Removes `Needs Plan Review` label, adds `Ready` label

### Human-in-the-loop workflow

The adversarial review is **for the human**, not for automatic refinement.
When plan-reviewer is enabled, the full lifecycle is:

1. **issue-refiner** produces or refines a plan → adds `Needs Plan Review`
2. **plan-reviewer** critiques the plan via a different AI → posts `## Plan Review` → adds `Ready`
3. **Human** reads both the plan and the adversarial critique, then decides:
   - **Plan is good** → add `Refined` label to start implementation
   - **Review raised valid concerns** → post feedback comments on the issue →
     issue-refiner detects unreacted comments, refines the plan, and routes it
     back through plan-reviewer for another review cycle

The review does **not** automatically feed back into refinement. This is
intentional — without a human gatekeeper, the two AIs could enter an infinite
loop of critiquing and revising each other's plans. The `Ready` label always
means "a human needs to look at this."

## issue-worker

**Source**: `src/jobs/issue-worker.ts`
**Trigger**: Issues labelled `Refined`
**Interval**: 5 minutes

- Removes the `Ready` label (work starting)
- Creates a worktree on branch `yeti/issue-<N>-<hex4>`
- Provides the issue title, body, and all comments as context
- Instructs Claude to read `yeti/OVERVIEW.md` for codebase context
- Claude implements the changes and makes commits
- If commits were produced: pushes the branch, generates a PR description
  (via a second Claude call with the diff, falling back to a diffstat if that
  fails), creates a PR titled `fix: resolve #N — <title>` that closes
  the issue
- Adds the `In Review` label to the issue (signals a PR is open for review)
- Removes the `Refined` label

### Multi-PR issues

If the implementation plan contains multiple `### PR N:` phases, the worker
creates one PR per phase:

- Each intermediate PR references `Part of #N` (not `Closes`), keeping the
  issue open
- The final PR uses `Closes #N` to auto-close the issue on merge
- PR titles include `(N/total)` suffixes

Before implementing each subsequent phase, the worker updates the plan comment
to reflect completed work: completed phases get `[COMPLETED]` prepended to
their titles, and remaining phases are revised to account for what has already
been merged. A `<!-- plan-updated-after-phase:N -->` marker prevents redundant
updates.

Between phases, the worker scans open issues for ones with merged `yeti/`
PRs but more phases remaining. When a PR has been merged and more phases
remain, it re-adds the `Refined` label, which triggers the next phase on the
next run. The current phase is determined by counting merged PRs with branch
prefixes matching the issue.

## ci-fixer

**Source**: `src/jobs/ci-fixer.ts`
**Trigger**: Any open PR (scans all open PRs per repo)
**Interval**: 10 minutes

Uses a two-phase identify/process pattern:

1. **Identify**: For each open PR, calls `identifyPRWork()` which checks merge
   state, CI status, and classifies failures. Returns typed `WorkItem` entries
   (discriminated union: `conflict`, `rerun`, `unrelated`, `fix`).
2. **Process**: Groups unrelated failures by repo (structural dedup), then
   processes remaining items concurrently.

Two responsibilities, checked in order for each PR:

### 1. Resolve merge conflicts

Checks `getPRMergeableState()`. If `CONFLICTING`:

- Creates a worktree from the PR branch
- Attempts `git merge origin/<base>` — if clean, pushes directly
- If conflicts exist, passes the conflict file list to Claude with
  instructions to resolve markers and complete the merge
- On failure, aborts the merge

If conflicts were resolved, the CI fix step is skipped (the fresh merge
commit will trigger a new CI run).

### 2. Fix CI failures

If checks are in a cancelled/startup-failure state, re-runs the workflow
instead of trying to fix code. Benign "already running" errors (where the
workflow restarted between detection and rerun) are caught and logged at info
level rather than reported as errors.

If Claude classifies the failure as unrelated to the PR (flakey tests, runner
issues, pre-existing failures), the failure is filed on a consolidated
per-repo `[ci-unrelated]` issue rather than attempting a code fix. Unrelated
failures are grouped by repo during the identify phase (structural dedup),
so concurrent PRs with unrelated failures in the same repo produce a single
issue rather than duplicates. All unrelated failures for a repo are tracked
in a single issue (titled `[ci-unrelated] CI failures unrelated to PR
changes`), with each occurrence logged as a comment containing the
fingerprint, PR reference, reason, a link to the failing GitHub Actions run,
and abbreviated log.

**Exception — `[ci-unrelated]` fix PRs**: When the PR being processed is
itself a fix for a `[ci-unrelated]` issue (detected by `[ci-unrelated]` in
the PR title), classification is skipped entirely and failures are always
treated as related. Without this guard, the classifier would see pre-existing
failures, classify them as "unrelated", and the PR would stall indefinitely
in a loop of filing redundant issues and reverting fix attempts. Errors on
these PRs are posted as comments directly on the PR (using an in-place
edit pattern to avoid spam) rather than creating `[yeti-error]` issues.

Otherwise:
- Fetches the failed run log via `getFailedRunLog()` (truncated to 20KB).
  The log fetch has a two-tier fallback: the primary `gh run view --log-failed`
  CLI command is tried first; if it returns empty (e.g. runner cancellations
  produce no structured failure output) or throws, the REST API endpoint
  (`/actions/jobs/{jobId}/logs`) is tried as a fallback. If both return empty,
  the workflow is re-run instead of being silently skipped.
- Creates a worktree from the PR branch
- Passes the failure log to Claude to analyze and fix
- Pushes fix commits

## review-addresser

**Source**: `src/jobs/review-addresser.ts`
**Trigger**: Yeti PRs (`yeti/` branch prefix) with unreacted review comments
**Interval**: 5 minutes

Scans all open PRs. For each PR with a `yeti/` branch prefix:

- Fetches all review feedback: review bodies (with state), inline code
  comments (with diff hunks), and general PR comments
- Returns `PRReviewData` with formatted text plus separate `commentIds` and
  `reviewCommentIds` arrays for reaction tracking
- Filters out comments belonging to **resolved** review threads (uses GraphQL
  API to check thread resolution status, since REST doesn't expose this)
- Filters out bare "LGTM" issue-tab comments (approval signals for
  auto-merger, not review feedback)
- Filters out comments that already have a 👍 reaction from Yeti
- Skips PRs where all comments have been addressed (no unreacted comments)
- Downloads images embedded in review comments for visual context
- Removes the `Ready` label (work starting)
- Creates a worktree from the PR branch
- Passes all unresolved feedback to Claude
- Pushes fix commits
- Posts Claude's response as a PR comment (summary of actions taken)
- Reacts 👍 to each addressed comment (both issue comments and review comments)
- Adds the `Ready` label (signals "Yeti is done, your turn")

## triage-yeti-errors

**Source**: `src/jobs/triage-yeti-errors.ts`
**Trigger**: `[yeti-error]` issues in `SELF_REPO` (title-based discovery)
**Interval**: 10 minutes

Investigates internal Yeti errors that were auto-reported by
`error-reporter.ts`. Only operates on the Yeti repository itself
(`SELF_REPO`). Discovers issues by title pattern (`[yeti-error] ...`) —
no trigger label required. Skips issues that already have a
`## Yeti Error Investigation Report` comment.

### Phase 1: Fingerprint deduplication (pre-investigation)

Before investigating, deduplicates incoming issues by fingerprint:

- Groups issues by fingerprint (extracted from `[yeti-error] <fingerprint>`
  title pattern)
- Checks existing open `[yeti-error]` issues for matching fingerprints
  (including "Known Fingerprints" tracking comments)
- Closes duplicates with a comment linking to the canonical issue
- When multiple new issues share a fingerprint, keeps the lowest-numbered one

### Phase 2: Investigation

For each canonical (non-duplicate) issue:

- Parses error details from the issue body: fingerprint, context, timestamp,
  and stack trace
- Creates a worktree on branch `yeti/investigate-error-<N>-<hex4>`
- Passes error details and other open error issues to Claude with instructions
  to read `yeti/OVERVIEW.md`, find the relevant source code, run diagnostic
  commands, and produce a root cause analysis
- Claude's output includes a `RELATED_ISSUES:` line identifying issues that
  share the same root cause

### Phase 3: Post-investigation deduplication

- Posts the investigation report as a comment prefixed with
  `## Yeti Error Investigation Report`
- If Claude identified related issues, closes them as duplicates of the
  canonical issue and updates a "Known Fingerprints" tracking comment
- Populates queue cache: `needs-triage` for uninvestigated issues

## doc-maintainer

**Source**: `src/jobs/doc-maintainer.ts`
**Trigger**: Daily schedule
**Schedule**: Runs at hour configured by `schedules.docMaintainerHour`
(default: 1 AM local time)

- Skips if an open `yeti/docs-*` PR already exists for the repo
- Skips if HEAD matches the last `[doc-maintainer]` commit (no new code
  changes to document)
- Creates a worktree on branch `yeti/docs-<YYYYMMDD>-<hex4>`
- Before running Claude, fetches recently-closed issues that had
  implementation plans and writes them to a temporary `.plans/` directory
  in the worktree (capped at 10 plans, each truncated to 5,000 characters)
- The time window for fetching closed issues is "since the last
  `[doc-maintainer]` commit", falling back to 7 days if no prior
  doc-maintainer commit exists
- Claude is instructed to extract valuable architectural context, design
  decisions, and patterns from these plans into the documentation
- The `.plans/` directory is cleaned up after Claude runs and is never
  committed
- Instructs Claude to create/update `yeti/OVERVIEW.md` and supporting docs
- If commits were produced: pushes and creates a PR titled
  `docs: update documentation for <repo>` (auto-merged by the auto-merger
  job once checks pass, with a safety guard ensuring only doc files are
  changed)

## auto-merger

**Source**: `src/jobs/auto-merger.ts`
**Trigger**: Dependabot PRs + LGTM'd Yeti PRs + doc PRs
**Interval**: 10 minutes

Scans all open PRs per repo. Before merging any PR, checks the PR's
mergeable state via `getPRMergeableState()`. PRs with merge conflicts
(`CONFLICTING`) are skipped with a warning; PRs in `UNKNOWN` state (GitHub
still computing) are silently skipped and re-evaluated on the next cycle.

For each PR:

- **Dependabot PRs** (`dependabot[bot]` author): merges if all CI checks pass
- **Yeti PRs** (`yeti/issue-` or `yeti/improve-` branch prefix): merges if
  the PR has a valid LGTM comment AND all CI checks pass. LGTM validation uses
  `isYetiComment()` (marker-based) rather than self-login to identify
  Yeti-authored comments, so LGTM from a shared GitHub account is accepted.
  Merge-from-base commits (e.g. from ci-fixer resolving conflicts) do not
  invalidate an existing LGTM. Other substantive commits pushed after the
  LGTM invalidate it and another LGTM is required.
- **Doc PRs** (`yeti/docs-` branch prefix): merges without requiring LGTM.
  Safety guards: verifies all changed files are doc-only (`yeti/**` or
  `*.md`) — if any non-doc files are present, the PR is skipped with a
  warning. Since doc-only PRs skip CI (via `paths-ignore` in workflows),
  accepts both "passing" checks and "no checks" (CI never ran). Rejects
  failing or in-progress checks.
- On merge of a Yeti PR, removes the `In Review` label from the linked issue
- **Branch protection**: When `mergePR()` fails with "base branch policy
  prohibits the merge", the PR is silently skipped (info log only, no error
  report, no notification, `In Review` label not removed). Other merge errors
  are still reported normally.
- Other PRs are ignored
- If checks are failing: logs a warning and skips
- If checks are pending: skips silently
- Does not create worktrees or invoke Claude — purely a merge gate

## repo-standards

**Source**: `src/jobs/repo-standards.ts`
**Trigger**: Daily schedule (also runs once on startup)
**Schedule**: Runs at hour configured by `schedules.repoStandardsHour`
(default: 2 AM local time)

For each repo:

- **Syncs label definitions** — calls `ensureAllLabels()` to create/update
  all labels defined in `LABEL_SPECS` (from `config.ts`) with correct colors
  and descriptions (`Refined`, `Ready`, `Priority`, `In Review`,
  `Needs Refinement`, `Needs Plan Review`)
- **Cleans up legacy labels** — removes labels in the `LEGACY_LABELS` set
  (old labels from the previous label-driven system: `Plan Produced`,
  `Reviewed`, `prod-report`, `investigated`, `yeti-mergeable`, `yeti-error`)

Does not create worktrees, PRs, or invoke Claude — purely label management
via the `gh` CLI.

## improvement-identifier

**Source**: `src/jobs/improvement-identifier.ts`
**Trigger**: Daily schedule
**Schedule**: Runs at hour configured by `schedules.improvementIdentifierHour`
(default: 3 AM local time)

Skips repos that
already have open `yeti/improve-*` PRs (prevents pile-up when previous
improvements haven't been merged). Repos are processed concurrently.
Two-phase approach per repo:

### Phase 1: Analysis

- Fetches all open issue and PR titles for deduplication context
- Creates a worktree on branch `yeti/improve-<hex4>`
- Instructs Claude to read `yeti/OVERVIEW.md` (if it exists) and analyze
  the codebase for actionable improvements (duplicate logic, dead code,
  performance issues, security concerns, missing error handling, stale TODOs)
- Claude responds with structured JSON listing improvements
- Analysis worktree is cleaned up before implementation begins

### Phase 2: Implementation

Suggested improvements (up to 10 per run) are implemented **concurrently**
via `Promise.allSettled`. Each improvement:

- Searches existing issues **and PRs** for duplicates (skips if found)
- Creates a fresh worktree on branch `yeti/improve-<hex4>`
- Instructs Claude to implement the specific improvement
- If commits were produced: pushes the branch, creates a PR titled
  `refactor: <improvement title>` (no labels applied)
- Errors in one improvement do not block processing of others

Conservative by design: only tangible improvements, no stylistic or
documentation suggestions. "No improvements found" is acceptable.

PRs created include a footer: *"Automated improvement by yeti improvement-identifier"*

## mkdocs-update

**Source**: `src/jobs/mkdocs-update.ts`
**Trigger**: Daily schedule
**Schedule**: Runs at hour configured by `schedules.mkdocsUpdateHour`
(default: 4 AM local time)

Scans repos for `mkdocs.yml` or `mkdocs.yaml` files and updates MkDocs
documentation to reflect recent source code changes. Follows the same
structure as doc-maintainer (single-phase, one PR per repo).

- Skips if an open `yeti/mkdocs-update-*` PR already exists for the repo
- Creates a worktree on branch `yeti/mkdocs-update-<YYYYMMDD>-<hex4>`
- Checks for `mkdocs.yml` or `mkdocs.yaml` in the worktree root; skips
  repos without either file (recorded as completed, not failed)
- Instructs Claude to read the MkDocs config, scan recent git history,
  and update only Markdown files under the docs directory (and
  `mkdocs.yml` itself if the nav structure needs it)
- Uses `JOB_AI` backend dispatch (supports Claude, Copilot, and Codex
  backends via `JOB_AI["mkdocs-update"]`)
- If commits were produced with a tree diff: pushes and creates a PR
  titled `docs: update mkdocs content for <repo>`
- Repos are processed concurrently with `Promise.allSettled`; errors in
  one repo do not block others

## issue-auditor

**Source**: `src/jobs/issue-auditor.ts`
**Trigger**: Daily schedule
**Schedule**: Runs at hour configured by `schedules.issueAuditorHour`
(default: 5 AM local time)

Reconciles every open issue across all repos, ensuring each is either labeled
"Ready" (waiting on a human) or in a state where Yeti will process it on the
next pass. No issues should fall between the cracks.

Does not invoke Claude or create worktrees — it's a lightweight, read-only
audit with targeted label fixes.

**Classification states:**

| State | Condition | Action |
|-------|-----------|--------|
| `refined` | Has "Refined" label | None — issue-worker handles |
| `in-progress` | Has open Yeti PR | Verify "In Review" label; add if missing |
| `needs-triage` | Is `[yeti-error]` or has game-ID, without investigation report | None — triage jobs handle |
| `needs-refinement` | No plan comment exists | None — issue-refiner handles |
| `needs-refinement` | Has plan but unreacted human feedback exists | None — issue-refiner handles |
| `ready` | Has plan, all feedback addressed | Verify "Ready" label; add if missing |
| `stuck-multi-phase` | Has merged Yeti PRs, multi-phase plan, more phases remaining, no "Refined" label, no open PR | Add "Ready" label (human decides when to resume) |

**Fixes applied**: Missing "Ready" labels (including for stuck multi-phase
issues that need human attention) and missing/stale "In Review" labels
(added when an issue has an open PR, removed when it doesn't).

**Notification**: Sent only when fixes are applied, with a summary of
which issues were fixed.

Per-repo errors are caught and reported without blocking other repos.

## prompt-evaluator

**Source**: `src/jobs/prompt-evaluator.ts`
**Trigger**: Daily schedule
**Schedule**: Runs at hour configured by `schedules.promptEvaluatorHour`
(default: midnight / 0 AM local time)

A self-improvement mechanism that A/B tests Yeti's plan-producing prompts
against AI-generated improved variants. Evaluates one prompt per run,
cycling through the `PROMPT_REGISTRY` round-robin (state persisted in
`~/.yeti/prompt-eval-state.json`).

**Registered prompts** (5 total):

| Prompt | Source file | Purpose |
|--------|------------|---------|
| `buildNewPlanPrompt` | `issue-refiner.ts` | Initial implementation plan from a GitHub issue |
| `buildRefinementPrompt` | `issue-refiner.ts` | Refine a plan based on human feedback |
| `buildFollowUpPrompt` | `issue-refiner.ts` | Answer follow-up questions on an issue with an open PR |
| `buildReviewPrompt` | `plan-reviewer.ts` | Critically review an implementation plan |
| `buildPrompt` (issue-worker) | `issue-worker.ts` | Implement a solution based on a plan |

**Evaluation pipeline** (all AI calls use the job's configured backend via
`JOB_AI["prompt-evaluator"]`):

1. **Read source**: Creates a read-only worktree, reads the prompt function's
   source code from the registered file
2. **Generate test inputs**: Asks AI to produce 4 diverse test cases (2
   realistic GitHub issues + 2 adversarial edge cases). Aborts if fewer
   than 4 are returned.
3. **Generate variant**: Asks AI to analyze the prompt for weaknesses and
   propose an improved version with a rationale
4. **A/B comparison**: For each test case, runs both the current prompt and
   the variant prompt, collecting outputs
5. **Judge**: For each test case, an AI judge scores both outputs on 4
   criteria (specificity, actionability, scope-awareness, uncertainty
   handling) on a 1–5 scale and declares a winner
6. **Report**: If the variant wins at least 3 of 4 test cases, files a
   GitHub issue in `SELF_REPO` with the `prompt-improvement` label
   containing full scores, reasoning, and collapsible output comparisons.
   Deduplicates by checking for existing issues with the same title.

The `prompt-improvement` label signals that a human should review the
proposed prompt change before applying it — no automatic prompt
modifications are made. Notifications are sent when an improvement is
found.

