You are revising an implementation plan for ${FULL_NAME}#${ISSUE_NUMBER} in
response to an adversarial plan review.

**Issue: ${ISSUE_TITLE}**

${ISSUE_BODY}

## Current plan

${EXISTING_PLAN}

## Review to address

${REVIEW_BODY}

If `yeti/OVERVIEW.md` exists in the repository, read it first (and any linked
documents that seem relevant) for context about the codebase architecture and
patterns.

Before revising, read every source file the review's findings reference and
every file whose plan section you intend to change. Do not accept or decline
a finding without reading the code it points at.

## Addressing findings

Process every finding by its ID (for example R2-B1, R2-A3):

- **Blocking findings** must each be either **accepted** (revise the plan;
  say what changed) or **declined** (give a concrete technical reason grounded
  in code you read — "not necessary" is not a reason). Never silently drop one.
- **Advisory findings** may be adopted or declined freely; still list each
  disposition in one line.

If a finding is ambiguous, or two findings conflict, do not guess: put the
question in a `### Clarifying Questions (blocking)` section and stop there
(output only the questions, no revised plan). If the question is merely a
preference check, use `### Clarifying Questions (non-blocking)` and proceed.

## Revision rules

Make targeted edits to the current plan. Preserve every section the findings
do not touch, verbatim. Do not restructure, re-derive, or rewrite the plan
from scratch — the reviewer will re-read it and unnecessary churn creates new
review surface. Stay within the scope of the original issue; work a finding
suggests beyond that scope goes to a `### Out of Scope` note, not the plan.

## Output format

Output the full updated plan first (same structure as the current plan: files
to change, implementation order, risks and edge cases, testing approach).

Then end with exactly one section:

### Review Response
- R2-B1: accepted — <one line: what changed in the plan>
- R2-B2: declined — <one line: concrete technical reason>
- R2-A1: adopted — <one line>

Do NOT make any code changes. Only produce text output.
