# prompt-evaluator

> Automated self-improvement: A/B tests Yeti's own prompts and files issues when a better variant is found.

| Property | Value |
|----------|-------|
| Type | Scheduled |
| Default hour | Midnight (`schedules.promptEvaluatorHour`) |
| Uses AI | Yes |
| Backend | Claude (configurable via `jobAi`) |
| Config key | `schedules.promptEvaluatorHour` |

!!! warning "Cost considerations"
    Each prompt-evaluator run makes **11 AI calls** (test-input generation, variant generation,
    8 A/B test runs, and a judge call). Running daily, this adds ~330 AI invocations per month
    purely for prompt self-improvement — not productive work. Consider scheduling it less
    frequently (e.g. weekly) via `schedules.promptEvaluatorHour` if AI usage costs are a concern,
    or disable it entirely if you don't need automated prompt improvement.

## What it does

The prompt-evaluator is a self-improvement mechanism for Yeti's plan-producing prompts. It reads the source code of registered prompt functions, generates an improved variant via AI, A/B tests both the current and variant prompts against synthetic GitHub issues, has AI judge the outputs, and files a GitHub issue (labeled `prompt-improvement`) when the variant wins convincingly.

Humans review and approve before any prompt change is applied -- no automatic modifications are made.

## Prompt Registry

The evaluator rotates through a registry of prompt functions, evaluating one per run:

| Prompt | Source File | Purpose |
|--------|-------------|---------|
| `buildNewPlanPrompt` | `src/jobs/issue-refiner.ts` | Produce an initial implementation plan from a GitHub issue |
| `buildRefinementPrompt` | `src/jobs/issue-refiner.ts` | Refine an existing plan based on human feedback |
| `buildFollowUpPrompt` | `src/jobs/issue-refiner.ts` | Answer follow-up questions while a PR is open |
| `buildReviewPrompt` | `src/jobs/plan-reviewer.ts` | Critically review an implementation plan |
| `buildPrompt` (issue-worker) | `src/jobs/issue-worker.ts` | Implement a solution based on an issue's plan |

State is persisted to `~/.yeti/prompt-eval-state.json` so each run picks up the next prompt in the registry.

## How it works

1. **Read prompt source** -- Creates a worktree from the default branch and reads the source file containing the target prompt function
2. **Generate test inputs** -- Asks AI to produce 4 test cases: 2 realistic GitHub issues (one well-specified, one vague) and 2 adversarial edge cases
3. **Generate variant** -- Asks AI to analyze the current prompt for weaknesses and propose an improved version with a rationale
4. **A/B comparison** -- Runs both the current prompt and the variant against all 4 test cases, collecting outputs
5. **Judge** -- An AI judge scores each output pair on four criteria (1--5 scale):
    - **Specificity** -- Does it reference concrete files, functions, or patterns?
    - **Actionability** -- Could a developer implement from this output?
    - **Scope awareness** -- Does it avoid over- or under-engineering?
    - **Uncertainty** -- Does it flag ambiguity instead of guessing?
6. **Report** -- If the variant wins at least 3 of 4 test cases, files a GitHub issue with the full evaluation report

## Duplicate Prevention

Before filing an issue, the evaluator searches for existing open issues with the same title. If one already exists, it skips filing to avoid duplicates.

## Output

When the variant wins, the filed issue includes:

- The rationale for the proposed change
- Per-test-case results with scores, winner, and reasoning
- Collapsible sections showing the full current and variant outputs
- The `prompt-improvement` label for easy filtering

## Related jobs

- [issue-refiner](issue-refiner.md) -- Source of most evaluated prompts
- [plan-reviewer](plan-reviewer.md) -- Source of the review prompt
- [issue-worker](issue-worker.md) -- Source of the implementation prompt
