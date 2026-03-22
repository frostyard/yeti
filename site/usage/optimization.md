# Optimization

Yeti runs standard `claude` and `copilot` CLI sessions inside your repository. Every job that calls AI spawns a real CLI process in a git worktree of your repo --- the same process you'd get if you opened a terminal, `cd`'d into your project, and ran `claude` yourself.

This means **all your existing agent configuration applies**. CLAUDE.md files, skills, hooks, settings --- Yeti's AI reads and follows them just like an interactive session would. The quality of Yeti's plans, implementations, and fixes is directly tied to how well your repository is set up for AI agents.

If Yeti is producing mediocre results, the fix is almost never in Yeti's configuration. It's in your repo.

---

## How Yeti invokes AI

When a job needs AI, Yeti:

1. Creates a git worktree of your repo at `~/.yeti/worktrees/<owner>/<repo>/<job>/<branch>`
2. Spawns the CLI in that worktree's root directory
3. Pipes the job-specific prompt (issue context, CI logs, review comments, etc.) to the process
4. Collects the output and any file changes

The exact invocations:

```
# Claude backend
claude -p --dangerously-skip-permissions

# Copilot backend
copilot --allow-all-tools -s --no-ask-user -p "<prompt>"
```

Both run with full filesystem access in your repo's worktree. The CLI loads whatever configuration it finds there --- exactly as it would in an interactive session.

---

## CLAUDE.md

The single most impactful optimization. Claude reads `CLAUDE.md` at the root of your repository before doing anything. This is where you tell the AI how your project works.

A well-written `CLAUDE.md` transforms Yeti's output from generic to project-aware. Without it, Claude is guessing at your conventions. With it, Claude follows your patterns.

### What to include

**Build and test commands** --- Claude needs to know how to verify its work:

```markdown
## Build & Test

npm ci                    # install dependencies
npm run build             # compile TypeScript
npm test                  # run all tests
npm run lint              # check formatting
```

**Architecture context** --- how the codebase is organized:

```markdown
## Architecture

This is a Next.js app with a PostgreSQL backend.
- `src/app/` — Next.js app router pages
- `src/lib/` — Shared utilities and database clients
- `src/components/` — React components (use shadcn/ui)
- `prisma/` — Database schema and migrations
```

**Conventions and standards** --- patterns Claude should follow:

```markdown
## Conventions

- Use `snake_case` for database columns, `camelCase` for TypeScript
- All API routes return `{ data, error }` envelope
- Components use CSS modules, not Tailwind
- Tests are co-located: `foo.test.ts` next to `foo.ts`
- Never use `any` — use `unknown` and narrow
```

**What NOT to do** --- guard rails are just as important as guidance:

```markdown
## Do not

- Do not modify migration files after they've been committed
- Do not add new npm dependencies without checking for existing alternatives
- Do not use default exports
```

### CLAUDE.md placement

Claude supports hierarchical instructions:

| File | Scope |
|------|-------|
| `CLAUDE.md` (repo root) | Applies to all work in the repo |
| `src/CLAUDE.md` | Applies when working in `src/` |
| `src/api/CLAUDE.md` | Applies when working in `src/api/` |
| `~/.claude/CLAUDE.md` | Your global instructions (all repos) |

Yeti's worktrees are full clones, so nested CLAUDE.md files work as expected. Use them to give specific guidance for specific parts of your codebase --- the API layer might have different conventions than the frontend.

---

## Copilot instructions

If you route jobs to the Copilot backend via `jobAi`, the equivalent configuration files are:

| File | Purpose |
|------|---------|
| `.github/copilot-instructions.md` | Repository-level instructions for Copilot |
| `AGENTS.md` | Agent-mode instructions (similar to CLAUDE.md) |

These files serve the same role as CLAUDE.md but for the Copilot CLI. If you're using both backends (e.g., Claude for implementation, Copilot for plan review), maintain both instruction files.

---

## Skills

Skills are reusable instruction sets that the Claude CLI loads on demand. They're especially powerful for Yeti because they can encode your team's processes --- coding standards, testing patterns, review criteria --- in a way that applies automatically to every AI task.

### Repository skills

Place skill files in `.claude/skills/` in your repo:

```
.claude/skills/
├── testing.md          # How to write tests in this project
├── api-design.md       # API conventions and patterns
└── database.md         # Migration and query patterns
```

Each skill file has frontmatter that tells Claude when to activate it:

```markdown
---
name: testing
description: Testing conventions for this project
---

## Testing Rules

- Use vitest, not jest
- Mock external boundaries only (HTTP, filesystem, database)
- Use factory functions from `src/test-helpers.ts` for test data
- Every new function needs at least one happy-path and one error test
- Integration tests go in `__tests__/integration/`
```

When Yeti's issue-worker implements a feature, Claude sees these skills and follows them. When the ci-fixer repairs a broken test, it knows your testing conventions. When the review-addresser responds to "add tests for this," it knows *how* you test.

### Global skills

Skills in `~/.claude/skills/` apply to all repos. Use these for cross-project standards --- your organization's coding style, security requirements, or documentation patterns.

---

## Hooks

Hooks are shell commands that run before or after Claude takes specific actions. They're configured in `.claude/settings.json` (per-repo) or `~/.claude/settings.json` (global).

Common uses for Yeti optimization:

**Auto-format after edits:**

```json
{
  "hooks": {
    "postToolUse": [
      {
        "matcher": "Edit|Write",
        "command": "npx prettier --write $FILE_PATH"
      }
    ]
  }
}
```

**Lint check before commit:**

```json
{
  "hooks": {
    "preToolUse": [
      {
        "matcher": "Bash",
        "command": "echo 'run npm run lint before committing'"
      }
    ]
  }
}
```

Since Yeti runs Claude with `--dangerously-skip-permissions`, hooks execute without prompts. Make sure your hooks are safe for unattended execution.

---

## yeti/OVERVIEW.md

Several Yeti jobs explicitly instruct the AI to read `yeti/OVERVIEW.md` before starting work. This file is maintained by the [doc-maintainer](../reference/jobs/doc-maintainer.md) job and serves as a comprehensive architecture guide written for AI consumption.

While CLAUDE.md gives *instructions* (do this, don't do that), `yeti/OVERVIEW.md` gives *context* (how the system works, why decisions were made, where things live). Both matter:

| File | Purpose | Audience | Maintained by |
|------|---------|----------|---------------|
| `CLAUDE.md` | Instructions and conventions | Claude CLI | You |
| `yeti/OVERVIEW.md` | Architecture and context | Yeti jobs | doc-maintainer (AI) |

If you don't have a `yeti/OVERVIEW.md`, the doc-maintainer job will create one. If the generated overview is inaccurate, edit it --- the doc-maintainer will preserve your manual changes and build on them in future updates.

You can also create additional docs under `yeti/` and link them from `OVERVIEW.md`. The doc-maintainer and issue-refiner will follow those links.

---

## .claude/settings.json

Per-repository settings that control Claude's tool permissions and behavior. Since Yeti runs with `--dangerously-skip-permissions`, most permission settings are bypassed --- but the file is still read for other configuration like hooks and MCP servers.

---

## Optimization checklist

Start here if Yeti's output quality isn't where you want it:

- [ ] **CLAUDE.md exists** with build commands, architecture overview, and conventions
- [ ] **Build/test commands work** --- if Claude can't verify its changes, quality drops
- [ ] **Conventions are explicit** --- don't assume Claude knows your patterns; spell them out
- [ ] **Guard rails are set** --- list things Claude should never do
- [ ] **yeti/OVERVIEW.md exists** --- run doc-maintainer once to bootstrap it, then refine
- [ ] **Skills cover complex patterns** --- testing, API design, database work
- [ ] **Copilot instructions match** (if using Copilot backend) --- `.github/copilot-instructions.md` and/or `AGENTS.md`

The repos that get the best results from Yeti are the ones that would also get the best results from a new human contributor: clear instructions, documented patterns, and fast feedback loops via CI.

---

## Per-job tuning

Beyond repo-level configuration, you can tune individual jobs via `jobAi` in Yeti's config:

```json
{
  "jobAi": {
    "plan-reviewer": { "backend": "copilot" },
    "issue-refiner": { "model": "opus" },
    "issue-worker": { "model": "sonnet" }
  }
}
```

This lets you route different jobs to different backends or models. A common pattern: use a stronger model for planning (where reasoning matters most) and a faster model for implementation (where the plan provides sufficient guidance). Or use a different backend entirely for plan review, so the reviewer has a genuinely different perspective from the planner.

See the [configuration reference](../reference/configuration.md) for details on `jobAi`.
