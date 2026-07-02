# Future Yeti — Vision

> Derived from research into agentic harnesses (GSD, CCPM, Symphony, PAUL, GAAI) and the OpenAI harness engineering post. Captured March 2026.

## The Through-Line

Current Yeti: one smart agent per job.
Future Yeti: an orchestrator that spawns the right specialized agent at the right time with the right tools and the right context.

The orchestrator stays thin. The agents stay focused. Context is a scarce resource — every design decision below treats it as one.

---

## Layer 1 — Planning (Before GitHub)

Issue creation is currently where Yeti's workflow begins. It shouldn't be.

The hard thinking — scope, constraints, success criteria, task decomposition with explicit dependency metadata — should happen before any GitHub issue exists. Issues are execution artifacts, not planning artifacts.

**Two conversation modes:**

- **Dream extraction** — agent leads a guided conversation surfacing scope, constraints, what success looks like, and explicit out-of-scope. Produces a PRD.
- **Assumptions mode** — agent reads the codebase first, surfaces evidence-based assumptions with confidence levels, user confirms or corrects. 2–4 interactions instead of 15–20. Better for established repos where patterns already exist.

The PRD feeds an epic decomposer that produces tasks with explicit `depends_on`, `parallel`, and `conflicts_with` metadata. Only then does Yeti create GitHub issues — as execution artifacts.

**Reference:** CCPM (`docs/CCPM.md`), GSD dream extraction

---

## Layer 2 — Refinement (Current Flow, Rebuilt)

### Replace Freeform Review with 8-Dimension Mechanical Checking

The current plan-reviewer writes freeform critique. This produces inconsistent feedback and unpredictable refinement cycles. A mechanical checker running the same 8 dimensions every time produces predictable, actionable results.

**The 8 dimensions:**

1. **Requirement coverage** — does the plan address all issue requirements?
2. **Task atomicity** — is each task independently committable?
3. **Dependency ordering** — correct execution sequence?
4. **File scope** — no excessive overlap between tasks?
5. **Verification commands** — testable done criteria per task?
6. **Context fit** — does each task fit in one agent context window?
7. **Gap detection** — any missing implementation steps?
8. **Nyquist compliance** — automated test command mapped to each requirement?

Each dimension: pass or fail with a specific fix required. Plan loops back to the planner until all 8 pass (max 3 iterations).

### The Nyquist Layer

Before issue-worker executes a single line, every planned change maps to a test command. The plan isn't done until you know how you'll verify it. This is what Yeti currently lacks most acutely.

**Reference:** GSD `docs/GSD.md` — plan checker and Nyquist validation

---

## Layer 3 — Execution (Current issue-worker, Rebuilt)

### Specialized Agents with Least-Privilege Tools

Currently issue-worker is one AI call with broad access. Future:

| Agent | Tools | Purpose |
|-------|-------|---------|
| Researcher | Read, Glob, Grep, WebSearch | Domain-specific research before planning |
| Planner | Read, Write (planning files only) | Task breakdown, dependency analysis |
| Executor | Read, Write, Edit, Bash | Implement tasks, commit code |
| Verifier | Read, Bash (read-only) | Post-execution goal check |

Each agent spawned fresh with scoped tools. Quality improves, cost drops, failure blast radius shrinks.

### Wave-Based Parallel Execution

Currently multi-phase issues are strictly sequential. Future: dependency analysis groups tasks into waves. Independent tasks (no `depends_on`) run in parallel worktrees simultaneously. Wave N waits for Wave N-1.

Yeti already has worktrees. The parallelization layer is the missing piece.

### Verifier Before PR Opens

Currently: issue-worker opens PR, reviewer catches problems after the fact.

Future: verifier agent runs immediately after execution, checks phase goals were met via goal-backward analysis. Only opens PR if verifier passes. Problems caught before the PR exists.

**Reference:** GSD `docs/GSD.md` — executor agents, wave execution, verifier

---

## Layer 4 — State and Continuity

### Persistent `.yeti/` State Per Repo

Exec plans checked into the working branch (see issue #197) are the seed. Full vision: `.yeti/` contains:

- Exec plans (active and completed)
- `STATE.md` — position, decisions, blockers, metrics across the full project lifecycle
- Milestone tracking

State survives between Yeti runs. If issue-worker stalls partway through, the next run reads `STATE.md` and resumes rather than starting over.

### Milestone Management

Currently Yeti has no concept above individual issues. Future:

- **Milestone** = group of related issues toward a larger goal
- Produced by the PRD/epic planning stage (Layer 1)
- Milestone-complete archives, creates a git tag, starts the next cycle
- Connects the planning layer to the execution layer as a durable artifact

### Repository Maturity as Entry Gate

Before any of this machinery fires on a repo, score it (see issue #201). Low-maturity repos get scaffolding proposals, not execution. The harness must exist before the agent can leverage it.

**Reference:** OpenAI harness engineering post, GAAI `docs/GAAI-Framework.md`

---

## Summary: What Changes

| Dimension | Current Yeti | Future Yeti |
|-----------|-------------|-------------|
| Planning starts at | GitHub issue | PRD conversation |
| Plan review | Freeform critique | 8-dimension mechanical checker |
| Test mapping | Ad-hoc | Nyquist layer (before execution) |
| Agent model | One per job | Specialized, least-privilege |
| Execution | Sequential phases | Wave-parallel |
| Post-execution | PR opens immediately | Verifier gate first |
| State persistence | Labels + comments | `.yeti/STATE.md` in repo |
| Work unit ceiling | Issue | Milestone |
| Repo readiness | Assumed | Scored and scaffolded |

---

## Related Issues

- #197 — Exec plans checked into working branch
- #200 — PRD and epic planning stage in Yeti UI
- #201 — Repository harness maturity scoring and scaffolding
