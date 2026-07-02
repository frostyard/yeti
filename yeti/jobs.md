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

Four modes:

### Fresh planning (no plan comment exists)

- Creates a worktree on branch `yeti/plan-<N>-<hex4>`
- Asks Claude for a fresh implementation plan using a four-step prompt structure:
  - **Step 1 — Evaluate plannability**: Assesses whether the issue provides
    enough detail (desired behavior, acceptance criteria, scope clarity) and
    verifies that referenced functions, types, APIs, and file paths exist in
    the codebase (phantom reference detection). If underspecified, outputs
    `### Clarifying Questions` with concrete options (e.g. "Should X behave
    like A or B?") instead of guessing. Supports partial planning — only
    aspects that are sufficiently clear are planned.
  - **Step 2 — Draft the implementation plan**: Per-file changes with
    rationale tied back to the issue (file paths must be confirmed by reading),
    implementation order with justification (each step must build/test
    independently), inter-change dependencies, risks/edge cases (including
    concurrency and boundary conditions), testing approach (unit vs
    integration vs manual, naming test files, conforming to repo conventions),
    and a "What NOT to plan" anti-gold-plating checklist.
  - **Step 3 — Self-critique and revise**: Two rounds of structured
    self-critique against five dimensions: unverified assumptions (re-read
    files referenced but not opened, revise plan to match reality), scope
    discipline (cut anything beyond issue requirements, justify file count),
    ordering correctness (trace import/dependency graph), risk honesty
    (surface omitted failure modes including concurrency and edge cases),
    and completeness vs. gold-plating (verify plan fully addresses the
    issue without exceeding it). The AI revises the plan after each
    critique round.
  - **Step 4 — Produce the final plan**: Outputs only the final revised
    plan. Internal drafts and critiques do not appear in the output.
  - **Anti-scope-creep guards**: The prompt explicitly forbids changes not
    required by the issue and instructs Claude to choose the narrowest
    reasonable interpretation when the issue is ambiguous, noting assumptions
    for reviewer correction.
- Posts the plan as a comment prefixed with `## Implementation Plan`
- If `plan-reviewer` is in `enabledJobs`: adds `Needs Plan Review` label (triggers adversarial review)
- Otherwise: adds the `Ready` label (signals "Yeti is done, your turn")

### Needs Refinement label routing (plan already exists)

When a plan comment already exists and the issue currently carries the
`Needs Refinement` label — the state plan-reviewer puts an issue into on a
NEEDS REVISION verdict, or a human can re-apply manually — `run()` picks one
of three paths per issue, in priority order:

1. **Human feedback present** (`findUnreactedHumanComments()` on comments
   after the plan returns non-empty) → `processRefinement()`. Human feedback
   always outranks a pending review: if `findReviewOfPlanVersion()` also
   finds a review of the current plan version, that review comment is
   prepended to the feedback list and addressed in the *same* revision pass,
   rather than running two separate revisions.
2. **No human feedback, but a review of the current plan version exists**
   (`findReviewOfPlanVersion()` — the reviewer's `<!-- yeti-review-of:id:updatedAt -->`
   marker matches the plan comment's current `id`/`updatedAt`) →
   `processReviewRevision()`: a **targeted** revision, not a replan. Renders
   `issue-refiner.revise.md` with the plan and the review body, and requires
   Claude to disposition every finding by ID (accepted/declined for Blocking,
   adopted/declined for Advisory) rather than silently dropping any. Claude
   edits the plan in place (same structure, only touched sections change) and
   ends with a separate `### Review Response` section, which is split off
   and posted as its own comment — the plan comment itself stays clean of
   disposition notes. If Claude instead emits `### Clarifying Questions
   (blocking)` with no revised plan, that block is posted verbatim as a
   comment and no label is added (waits for a human). Otherwise: removes
   `Needs Refinement`, adds `Needs Plan Review` — sending the issue back
   through plan-reviewer for the next round. If Claude returns empty output,
   the task fails and the unchanged labels cause the next scan to retry, but
   after 3 consecutive empty review-revision outputs for the same issue the
   job reports an error, removes `Needs Refinement`, adds `Ready`, and posts a
   warning comment so a human takes over; the streak is counted from task
   history and resets after a non-empty task or a prior escalation.
3. **Neither** (the label was re-added with no new comment and no pending
   review) → `processIssue()`, the same fresh-planning path as when no plan
   exists — a deliberate "start over" escape hatch for a human who wants a
   from-scratch replan rather than an incremental revision.

Both `processRefinement` and non-empty `processReviewRevision` runs remove
the `Needs Refinement` label whether or not the resulting plan is actionable
— an issue with only clarifying questions is left with no work-triggering
label at all, waiting for a human answer.

### Refinement (unreacted human comments after plan)

Runs via `processRefinement()` — reached both when a plan exists without the
`Needs Refinement` label (comment-driven state machine) and as case 1 of the
label-routing above (human feedback present with the label applied, which may
also absorb a pending review comment into the same pass).

- Finds human comments posted after the latest plan comment
- Checks each comment for a 👍 reaction from Yeti (tracked items)
- If unreacted comments exist, creates a worktree on branch `yeti/plan-<N>-<hex4>`
- Asks Claude to produce an updated plan addressing the feedback, using a
  structured refinement prompt that enforces:
  - **Grounding**: Claude must read every source file referenced by feedback
    or proposed for change before revising those plan sections
  - **Per-comment processing**: Each feedback comment is addressed one at a
    time in order — quote, explain the change, or escalate to clarifying questions
  - **Scope guard**: No new files, dependencies, refactors, or "while we're
    at it" improvements beyond what feedback requested; out-of-scope
    suggestions are captured in a separate section
  - **Conflict handling**: Contradictory feedback is flagged in clarifying
    questions rather than silently choosing a side
  - **Verification step**: After revision, Claude re-checks that every
    comment was addressed, no risks were accidentally removed, and
    implementation order remains correct
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
Copilot (or Gemini via Copilot) critiques it. Verdict mechanics and marker
dedup live in the shared `src/review-contract.ts` module (see
[Modules](modules.md)), used by both plan-reviewer and issue-refiner.

- Scans open issues with the `Needs Plan Review` label
- Skips issues with the `Refined` label (being implemented)
- Finds the most recent `## Implementation Plan` comment
- Skips if a review already exists for this **exact plan version** —
  `findReviewOfPlanVersion()` checks for a posted review comment containing
  `<!-- yeti-review-of:<planCommentId>:<planUpdatedAt> -->`. Because the
  marker binds to the plan comment's `updatedAt`, editing the plan in place
  (as `processRefinement`/`processReviewRevision` in issue-refiner do)
  automatically invalidates the old marker and re-arms the reviewer — no
  reaction bookkeeping is used for this dedup.
- Creates a worktree for codebase context
- Builds the review prompt (`buildReviewPrompt()`, rendering
  `plan-reviewer.md`) with:
  - **`THREAD_SECTION`** — every other comment on the issue, in order, each
    labeled by provenance: `Comment by @user (automated by Yeti):`,
    `Comment by @user (bot):`, or `MAINTAINER (binding) — comment by @user:`
    for human comments. The `MAINTAINER (binding)` label tells the reviewer
    a human decision is not up for re-litigation.
  - **`ROUND_INFO`** — `"This is review round N of maxPlanRounds."`, plus,
    only on the final round, an explicit instruction not to manufacture
    findings if nothing rises to Blocking (so the loop can actually converge
    to APPROVED at the cap instead of stalling on invented nitpicks).
  - The plan comment body itself (`PLAN_BODY`), elided from `THREAD_SECTION`
    so it isn't duplicated in the prompt.
- Uses the configured backend/model from `JOB_AI["plan-reviewer"]` (uses `enqueueCopilot` for copilot, `enqueueCodex` for codex, `enqueue` for claude)
- **Blocking/Advisory contract** (full rules in `src/policies/plan-reviewer.md`):
  a finding is **Blocking** only if implementing the plan as written would
  fail an explicit issue requirement, break existing behavior/build/tests,
  rest on a codebase claim the reviewer verified is false, or contradict an
  explicit maintainer decision in the thread — every Blocking finding must
  cite a `path:line` the reviewer actually read. Everything else (style,
  test-coverage suggestions, "consider also") is **Advisory** and never gates
  approval. On round 2+, the reviewer must first disposition every finding
  from the prior round (resolved/not resolved/settled) before raising new
  ones.
- **Verdict is always requested and always rendered**, whether or not
  `reviewLoop` is on: the AI ends its output with `VERDICT: APPROVED` or
  `VERDICT: NEEDS REVISION` on its own line (last such line wins if more than
  one appears); `renderVerdict()` replaces that raw line with a bold
  human-readable form in the posted comment — `**Verdict: APPROVED**` or
  `**Verdict: NEEDS REVISION** (N blocking)`, counting `[R<n>-B<n>]` bullets.
  A missing verdict line is logged and treated as needs-revision.
- Posts the review as a comment prefixed with `## Plan Review`, worktree
  paths scrubbed (`claude.scrubWorktreePaths()`), followed by the invisible
  `<!-- yeti-review-of:id:updatedAt -->` marker (not shown to humans)
- Label transition depends on `reviewLoop`:
  - **`reviewLoop` off** (default): always removes `Needs Plan Review`, adds
    `Ready` — the human-in-the-loop workflow below.
  - **`reviewLoop` on, verdict APPROVED**: removes `Needs Plan Review`, adds
    `Ready`.
  - **`reviewLoop` on, verdict NEEDS REVISION, under `maxPlanRounds`**:
    removes `Needs Plan Review`, adds `Needs Refinement` — sends the issue
    back to issue-refiner's label-routing (see issue-refiner's
    `processReviewRevision`) for a targeted revision, no human involved.
  - **`reviewLoop` on, verdict NEEDS REVISION, at `maxPlanRounds`**: posts a
    "⚠️ Maximum plan review rounds reached" warning comment, then removes
    `Needs Plan Review` and adds `Ready` — the loop always terminates at the
    cap rather than cycling indefinitely.

### Human-in-the-loop workflow (`reviewLoop` off — the default)

The adversarial review is **for the human**, not for automatic refinement.
With `reviewLoop` off, the full lifecycle is:

1. **issue-refiner** produces or refines a plan → adds `Needs Plan Review`
2. **plan-reviewer** critiques the plan via a different AI → posts `## Plan Review` (with verdict) → adds `Ready`
3. **Human** reads both the plan and the adversarial critique, then decides:
   - **Plan is good** → add `Refined` label to start implementation
   - **Review raised valid concerns** → post feedback comments on the issue →
     issue-refiner detects unreacted comments, refines the plan, and routes it
     back through plan-reviewer for another review cycle

Without a human gatekeeper, two AIs critiquing and revising each other's
plans could loop indefinitely — `reviewLoop` off avoids that by always
landing on `Ready` and waiting for a human. The `Ready` label always means
"a human needs to look at this" whenever `reviewLoop` is off.

### Convergent loop workflow (`reviewLoop` on)

With `reviewLoop` on, the same review runs but a NEEDS REVISION verdict
short-circuits straight back to issue-refiner instead of stopping at
`Ready`:

1. **issue-refiner** produces or refines a plan → adds `Needs Plan Review`
2. **plan-reviewer** reviews with full thread context → posts `## Plan Review` with a verdict
3. **APPROVED** → `Ready` (human implements or approves); **NEEDS REVISION
   under the round cap** → `Needs Refinement`, and issue-refiner's
   `processReviewRevision()` (see the issue-refiner section) makes a
   targeted, in-place revision addressing every finding by ID, then re-adds
   `Needs Plan Review` — repeating from step 2
4. This repeats until either APPROVED, or `maxPlanRounds` review rounds
   (counted since the most recent human comment via `countPlanRounds()`)
   have completed, at which point plan-reviewer posts a warning and forces
   `Ready` regardless of verdict
5. **A human comment posted at any point outranks the loop**: issue-refiner's
   label routing checks for unreacted human feedback first, routes it (and
   any pending review) to a full `processRefinement()` pass instead of
   `processReviewRevision()`, and the next `countPlanRounds()` call resets to
   0 since rounds only count reviews posted after the last human comment

No AI-to-AI loop runs unbounded: the round cap and the "don't manufacture
findings on the final round" prompt instruction both push the loop toward
termination.

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
- Creates a worktree on branch `yeti/docs-<YYYYMMDD>-<hex4>`
- Before checking for code changes, ensures `CLAUDE.md` contains the
  standard `## Documentation` block with `**update documentation**` and
  `**yeti/ directory**` directives. If missing, adds them and commits
  (commit message omits `[doc-maintainer]` so this maintenance commit is not
  treated as a doc-maintainer run when locating the last `[doc-maintainer]`
  commit)
- Skips if HEAD matches the last `[doc-maintainer]` commit (no new code
  changes to document)
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
| `needs-refinement` | Has plan with blocking clarifying questions (`isPlanActionable()` returns false) | None — waits for human input |
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

## learning-consolidator

**Source**: `src/jobs/learning-consolidator.ts`
**Trigger**: Daily schedule, or immediately when the pending-learnings count
reaches `learningsPendingThreshold`
**Schedule**: Runs at hour configured by `schedules.learningConsolidatorHour`
(default: 6 AM local time)

Closes the yeti-side (environment/tooling) half of the self-improvement loop
(see `src/learnings.ts` in [Modules](modules.md)). Operates only on
`SELF_REPO` — the repo Yeti's own source lives in — since its job is to edit
Yeti's own policies and docs, not a target repo.

**Inputs**: pending `"yeti"`-kind rows from the `learnings` table (see
[Database Schema](database-schema.md)), fetched via
`db.getPendingLearnings("yeti")`. If there are none, the job returns
immediately without creating a worktree or task record.

**Guards**:

- **Tier check**: skips (info log only) if `SELF_REPO` doesn't have at least
  the `createPR` capability tier — mirrors the guard other PR-creating jobs use.
- **Fresh duplicate-PR check**: before doing any work, lists open PRs on
  `SELF_REPO` with `fresh: true` (bypassing the `listPRs` 60s TTL cache — same
  rationale as `getOpenPRForIssue()`) and skips if any open PR's head branch
  starts with `yeti/learnings-`. This prevents pile-up when a previous
  consolidation PR hasn't been merged yet, and avoids the race where a
  just-created PR is invisible during the cache window.
- **Tree-diff guard**: after the AI pass, only pushes/creates a PR if both
  `hasNewCommits(wtPath, defaultBranch)` and `hasTreeDiff(wtPath,
  defaultBranch)` are true (the standard PR-creating-job guard — see Key
  Patterns). If the AI dismissed every pending learning (no commits expected)
  this is simply skipped; if some learnings were left neither dismissed nor
  committed, a warning is logged and they remain `pending` for the next run.

**Policy**: `learning-consolidator.md`, rendered with a single `${LEARNINGS}`
variable — `formatLearnings(rows)` renders each pending row as one bullet:
`- [id] (reported by <job_name> while working on <repo>, <created_at>)
<summary>`. The policy instructs the AI to read `yeti/OVERVIEW.md` and
`src/policies/_preamble.md`, then for each learning either fold it into
`_preamble.md` (environment-wide), a specific job policy (job-specific),
a `yeti/` doc (architectural knowledge about Yeti itself), or leave it
alone (already covered / not actionable) — editing and merging existing
guidance rather than appending changelog-style entries.

**DISMISSED line protocol**: after committing its edits (or making none), the
AI prints one line per learning it chose *not* to fold in, in the exact form
`DISMISSED: <id>: <one-line reason>`. `parseDismissals(output)` extracts these
via `/^DISMISSED:\s*(\d+)\s*:\s*(.+)$/gim`, and the job filters the parsed IDs
against the actual pending set (`pendingIds`) before acting — an AI
hallucinating an ID that wasn't in the pending list is silently ignored
rather than crashing or dismissing an unrelated row. Each valid dismissal
calls `db.dismissLearning(id, reason)`.

**Outputs / status transitions**:

- Dismissed learnings (from the parsed `DISMISSED:` lines) → `status =
  'dismissed'`, `reason` set.
- When a PR is created, **every** non-dismissed learning in the batch —
  `consolidated = pending.filter(l => !dismissedIds.has(l.id))` — is marked
  `status = 'consolidated'` with `pr_number` set, via
  `db.markLearningsConsolidated(ids, prNumber)`. This is not verified per
  learning: the AI may have silently ignored one without dismissing it, and
  it still gets marked `consolidated` alongside the ones actually folded in.
  The "consolidated" list in the PR body is the AI's claim; a human reviewing
  the PR should cross-check it against the actual diff before merging.
- A learning stays `pending` only when the run as a whole produces no PR —
  i.e. the tree-diff guard above trips (no new commits or no tree diff) while
  `consolidated.length > 0`. In that case none of the batch's non-dismissed
  learnings are touched and all of them remain `pending`, picked up again on
  the next run.
- On success: opens a PR titled `chore(learnings): consolidate <N>
  environment learning(s)` against `SELF_REPO`'s default branch, branch name
  `yeti/learnings-<datestamp>-<hex4>`. The PR body (`buildPRBody()`) lists
  each consolidated learning (with reporting job/repo) and, if any, a
  "Dismissed" section with `[id] <reason>` bullets, plus a footer noting that
  merging deploys the learnings into every future agent prompt. Sends a
  `notify()` on success.

Unlike other PR-creating jobs, learning-consolidator does not invoke
`enforceLearnings()` on itself — its own AI pass edits Yeti's policies/docs
directly rather than doing general-purpose repo work, so there is no
work-session learning to gate.
