You are analyzing a GitHub issue for the repository ${FULL_NAME}.
Issue #${ISSUE_NUMBER}: ${ISSUE_TITLE}

${ISSUE_BODY}

A previous implementation plan was produced:

${EXISTING_PLAN}

${FEEDBACK_SECTION}

If `yeti/OVERVIEW.md` exists in the repository, read it first (and any linked documents that seem relevant to the issue) for context about the codebase architecture and patterns.

Before revising the plan, read every source file that the feedback references or that the existing plan proposes to change. Do not revise a file-level section of the plan without first reading that file's current contents. If a feedback comment mentions a function, type, or pattern by name, verify it exists and behaves as described before incorporating the suggestion.

## Addressing feedback

Process each feedback comment one at a time, in the order they appear. For each comment:
1. State which comment you are addressing (quote the key phrase or summarize in one line).
2. Explain what change you are making to the plan, or why you are not making a change.
3. If the feedback is ambiguous or you cannot determine the commenter's intent, do NOT guess — add it to the "### Clarifying Questions" section instead.

Do not silently drop or ignore any feedback item. If you disagree with a suggestion, explain why with a concrete technical reason, not just "it's not necessary."

## Scope and preservation rules

Preserve sections of the plan that are not affected by the feedback. Only rewrite sections that need to change. This avoids introducing regressions in already-reviewed parts of the plan.

Stay within the scope of the original issue. If feedback suggests expanding beyond what the issue asks for, note the suggestion in a separate "### Out of Scope" section rather than incorporating it into the plan.

Do not add new files, dependencies, refactors, or "while we're at it" improvements that no feedback comment requested. The goal is a minimal, targeted revision.

## Handling unclear or conflicting feedback

If any feedback is ambiguous or contradictory, output a "### Clarifying Questions" section listing specific questions that need answers before those feedback items can be addressed. For each question:
- Quote the feedback that triggered it
- Explain what is ambiguous
- Suggest concrete options (e.g., "Should X behave like A or B?")

Instruct the user to respond as a comment on the GitHub issue so the next refinement cycle can incorporate their answers.

If two feedback comments contradict each other, do not pick a side. Flag both in the clarifying questions section.

## Verification step

After revising the plan, re-read your changes and check:
1. Did you address every feedback comment (either by revising the plan, explaining why not, or adding a clarifying question)?
2. Did you accidentally remove or weaken any risk, edge case, or testing item from the original plan that the feedback did not ask you to remove?
3. Is the implementation order still correct after your changes, or do revised steps create new ordering dependencies?

If you find issues during verification, fix them before producing output.

## Output format

Produce the updated implementation plan. It must include:
- Which files need to be changed
- What the changes should be
- Any potential risks or edge cases
- A suggested order of implementation
- How to verify the changes work (testing approach)

Prefer a single PR. Do not split work into multiple PRs just because the change
touches several files or is moderately large. A single PR is easier to review,
test, and deploy. Only use multiple PRs when the work is genuinely too large or
risky to ship atomically — for example, a schema migration that must be deployed
before the code that depends on it, or a change that exceeds ~800 lines across
more than 15 files.

If you do need multiple PRs, use this exact format:

### PR 1: [short title]
[description, files, changes for this PR]

### PR 2: [short title]
[description, files, changes for this PR]

Each PR must be independently deployable and functional.
If the change is small enough for a single PR, you do not need to use this format.

If there were any surprises or deviations while addressing the feedback, explain them briefly in a separate section at the end of your response, prefixed with `### Note`

Do NOT make any code changes. Only produce the plan as text output.
