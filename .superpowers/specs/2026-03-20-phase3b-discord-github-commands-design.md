# Phase 3b: Discord GitHub Commands

**Date:** 2026-03-20
**Status:** Approved
**Approach:** Extend existing `handleCommand()` switch in `discord.ts` with 3 new GitHub commands

## Overview

Add three GitHub-oriented commands to the Discord bot: creating issues, summarizing issues/PRs via Claude, and labeling issues for Yeti to process. All repos are force-scoped to the first `GITHUB_OWNERS` entry (default: `frostyard`).

## New Commands

| Command | Syntax | Action |
|---------|--------|--------|
| `issue` | `!yeti issue <repo> <title...>` | Creates a GitHub issue in `frostyard/<repo>` with the given title (empty body, no labels). Replies with confirmation and issue number. |
| `look` | `!yeti look <repo>#<number>` | Fetches issue/PR metadata, body, and comments. Queues Claude to generate an intelligent summary. Replies with "Looking into it..." then follows up with the analysis. |
| `assign` | `!yeti assign <repo>#<number>` | Adds the "Refined" label to the issue so Yeti picks it up for implementation. Replies with confirmation. |

## Repo Resolution

All commands use short repo names (e.g., `snosi` not `frostyard/snosi`). The first entry from `GITHUB_OWNERS` config is used as the org prefix. Internally: `snosi` → `frostyard/snosi`.

Before executing any command, the resolved `frostyard/<repo>` is validated against `listRepos()`. If not found, reply: "Unknown repo: **snosi**"

## Command Details

### `!yeti issue <repo> <title...>`

1. Parse first arg as repo name, remaining args joined as issue title
2. Validate: repo name present, title present, repo exists in `listRepos()`
3. Call `gh.createIssue("frostyard/<repo>", title, "", [])`
4. Reply: "Created **frostyard/snosi#123**: Fix the login bug"
5. On error: reply with error message

### `!yeti look <repo>#<number>`

1. Parse `<repo>#<number>` format (e.g., `snosi#42`)
2. Validate: format correct, repo exists
3. Reply immediately: "Looking into **frostyard/snosi#42**..."
4. Fetch via `gh` functions:
   - `getIssueBody(repo, number)` — issue/PR body text
   - `getIssueComments(repo, number)` — comment thread
   - Issue metadata (title, state, labels) via `gh issue view --json`
5. Queue Claude via `claude.enqueue()` wrapping `claude.runClaude()` with a prompt:
   - "Summarize this GitHub issue. Include: what it's about, current state, key discussion points, and any action items."
   - Pass title, state, labels, body, and comments as context
6. Send follow-up reply with Claude's analysis
7. On error: reply with error message

The Claude call uses the bounded worker queue (default 2 workers), respecting existing concurrency limits. It runs in a temporary directory (no worktree needed — pure text analysis).

### `!yeti assign <repo>#<number>`

1. Parse `<repo>#<number>` format
2. Validate: format correct, repo exists
3. Call `gh.addLabel("frostyard/<repo>", number, "Refined")`
4. Reply: "Labeled **frostyard/snosi#42** as Refined"
5. On error: reply with error message

## Changes to discord.ts

### New Imports

```typescript
import { GITHUB_OWNERS } from "./config.js";
import * as gh from "./github.js";
import { enqueue, runClaude } from "./claude.js";
```

### handleCommand() Changes

- The `handleCommand` function currently receives `(command, param, message)`. The `param` is only the second arg. For `issue`, we need all remaining args for the title. Change to pass the full `args` array instead of just `param`.
- Add `issue`, `look`, `assign` cases to the switch
- Update `help` output to include the new commands

### Helper: resolveRepo()

```typescript
function resolveRepo(shortName: string): string {
  return `${GITHUB_OWNERS[0]}/${shortName}`;
}
```

### Helper: parseRepoRef()

```typescript
function parseRepoRef(ref: string): { repo: string; number: number } | null {
  const match = ref.match(/^([^#]+)#(\d+)$/);
  if (!match) return null;
  return { repo: resolveRepo(match[1]), number: Number(match[2]) };
}
```

### Repo Validation

```typescript
async function validateRepo(repoFullName: string): Promise<boolean> {
  const repos = await gh.listRepos();
  return repos.some(r => r.fullName === repoFullName);
}
```

## Updated Help Output

```
**Yeti Commands:**
`!yeti status` — show overview
`!yeti jobs` — list all jobs
`!yeti trigger <job>` — trigger a job
`!yeti pause <job>` — pause a job
`!yeti resume <job>` — resume a job
`!yeti issue <repo> <title>` — create a GitHub issue
`!yeti look <repo>#<number>` — summarize an issue/PR
`!yeti assign <repo>#<number>` — label issue as Refined
`!yeti help` — this message
```

## Testing

Add test cases to `src/discord.test.ts`:

- `issue` command: valid creation, missing repo, missing title, unknown repo
- `look` command: valid lookup with Claude summary, invalid format, unknown repo
- `assign` command: valid label, invalid format, unknown repo
- `parseRepoRef()` parsing: valid refs, invalid formats
- `resolveRepo()`: prepends org name
- Repo validation against mocked `listRepos()`

Mock `gh.createIssue`, `gh.addLabel`, `gh.getIssueBody`, `gh.getIssueComments`, `gh.listRepos`, `claude.enqueue`, `claude.runClaude`.

## Documentation Updates

- Update `yeti/discord-setup.md` — add new commands to the commands reference
- Update `CLAUDE.md` — mention GitHub commands in discord.ts description

## Scope Boundaries

**In scope:**
- 3 new commands: issue, look, assign
- Org-scoped repo resolution
- Repo validation
- Claude integration for look
- Updated help output
- Tests
- Doc updates

**Out of scope:**
- Thread-based body editing for issues
- Free-form message interpretation
- Discord embeds or rich formatting
- PR-specific commands (look works for both issues and PRs)
