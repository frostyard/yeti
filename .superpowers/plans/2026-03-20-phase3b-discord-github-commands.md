# Phase 3b: Discord GitHub Commands — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 3 GitHub commands (issue, look, assign) to the Discord bot with org-scoped repo resolution.

**Architecture:** Extend `handleCommand()` in `discord.ts` with new cases. Add helper functions for repo resolution and validation. The `look` command uses Claude via the existing bounded queue.

**Tech Stack:** Node.js 22, TypeScript, discord.js, Vitest

**Spec:** `.superpowers/specs/2026-03-20-phase3b-discord-github-commands-design.md`

---

### Task 1: Add GitHub Commands to discord.ts

**Files:**
- Modify: `src/discord.ts`

- [ ] **Step 1: Create feature branch**

```bash
git checkout -b feat/discord-github-commands
```

- [ ] **Step 2: Add new imports to discord.ts**

Add after the existing imports:

```typescript
import { GITHUB_OWNERS } from "./config.js";
import * as gh from "./github.js";
import { enqueue, runClaude } from "./claude.js";
```

- [ ] **Step 3: Add helper functions**

Add before `handleCommand()`:

```typescript
function resolveRepo(shortName: string): string {
  return `${GITHUB_OWNERS[0]}/${shortName}`;
}

function parseRepoRef(ref: string): { repo: string; number: number } | null {
  const match = ref.match(/^([^#]+)#(\d+)$/);
  if (!match) return null;
  return { repo: resolveRepo(match[1]), number: Number(match[2]) };
}

async function validateRepo(repoFullName: string): Promise<boolean> {
  const repos = await gh.listRepos();
  return repos.some(r => r.fullName === repoFullName);
}
```

- [ ] **Step 4: Change handleCommand signature to accept full args array**

The current signature is:
```typescript
async function handleCommand(command: string, param: string | undefined, message: Message): Promise<void> {
```

Change to:
```typescript
async function handleCommand(command: string, args: string[], message: Message): Promise<void> {
```

Update all existing command cases that use `param` to use `args[0]` instead:
- `trigger`: `const jobName = args[0];` then `if (!jobName) { ... }`
- `pause`: same
- `resume`: same

Update the caller in `messageCreate` to pass `args.slice(1)` instead of `param`:
```typescript
const rest = message.content.slice("!yeti".length).trim();
const words = rest ? rest.split(/\s+/) : ["help"];
const command = words[0];
const commandArgs = words.slice(1);

handleCommand(command, commandArgs, message).catch((err) => {
  message.reply(`Error: ${err.message}`).catch(() => {});
});
```

- [ ] **Step 5: Add `issue` command case**

```typescript
case "issue": {
  const repoName = args[0];
  const title = args.slice(1).join(" ");
  if (!repoName || !title) {
    await message.reply("Usage: `!yeti issue <repo> <title>`");
    return;
  }
  const fullRepo = resolveRepo(repoName);
  if (!await validateRepo(fullRepo)) {
    await message.reply(`Unknown repo: **${repoName}**`);
    return;
  }
  const issueNum = await gh.createIssue(fullRepo, title, "", []);
  await message.reply(`Created **${fullRepo}#${issueNum}**: ${title}`);
  break;
}
```

- [ ] **Step 6: Add `look` command case**

```typescript
case "look": {
  const ref = parseRepoRef(args[0] ?? "");
  if (!ref) {
    await message.reply("Usage: `!yeti look <repo>#<number>`");
    return;
  }
  if (!await validateRepo(ref.repo)) {
    await message.reply(`Unknown repo: **${args[0].split("#")[0]}**`);
    return;
  }
  await message.reply(`Looking into **${ref.repo}#${ref.number}**...`);

  try {
    const [body, comments] = await Promise.all([
      gh.getIssueBody(ref.repo, ref.number),
      gh.getIssueComments(ref.repo, ref.number),
    ]);

    const commentText = comments.length > 0
      ? comments.map(c => `**${c.login}:** ${c.body}`).join("\n\n")
      : "No comments.";

    const prompt = [
      "Summarize this GitHub issue concisely. Include: what it's about, current state, key discussion points, and any action items.",
      "",
      `Issue: ${ref.repo}#${ref.number}`,
      "",
      "Body:",
      body || "(empty)",
      "",
      "Comments:",
      commentText,
    ].join("\n");

    const summary = await enqueue(() => runClaude(prompt, process.cwd()));
    const truncated = summary.length > 1900 ? summary.slice(0, 1900) + "..." : summary;
    await message.reply(truncated);
  } catch (err) {
    await message.reply(`Failed to analyze: ${(err as Error).message}`);
  }
  break;
}
```

- [ ] **Step 7: Add `assign` command case**

```typescript
case "assign": {
  const ref = parseRepoRef(args[0] ?? "");
  if (!ref) {
    await message.reply("Usage: `!yeti assign <repo>#<number>`");
    return;
  }
  if (!await validateRepo(ref.repo)) {
    await message.reply(`Unknown repo: **${args[0].split("#")[0]}**`);
    return;
  }
  await gh.addLabel(ref.repo, ref.number, "Refined");
  await message.reply(`Labeled **${ref.repo}#${ref.number}** as Refined`);
  break;
}
```

- [ ] **Step 8: Update help command**

Update the help text to include the new commands:

```typescript
case "help": {
  await message.reply(
    "**Yeti Commands:**\n" +
    "`!yeti status` — show overview\n" +
    "`!yeti jobs` — list all jobs\n" +
    "`!yeti trigger <job>` — trigger a job\n" +
    "`!yeti pause <job>` — pause a job\n" +
    "`!yeti resume <job>` — resume a job\n" +
    "`!yeti issue <repo> <title>` — create a GitHub issue\n" +
    "`!yeti look <repo>#<number>` — summarize an issue/PR\n" +
    "`!yeti assign <repo>#<number>` — label issue as Refined\n" +
    "`!yeti help` — this message"
  );
  break;
}
```

- [ ] **Step 9: Verify build**

```bash
npx tsc --noEmit
```

- [ ] **Step 10: Commit**

```bash
git add src/discord.ts
git commit -m "feat: add issue, look, and assign commands to discord bot"
```

---

### Task 2: Add Tests for New Commands

**Files:**
- Modify: `src/discord.test.ts`

- [ ] **Step 1: Add mocks for new imports**

Add mocks for `github.js` and `claude.js` if not already present:

```typescript
vi.mock("./github.js", () => ({
  listRepos: vi.fn(() => Promise.resolve([
    { owner: "frostyard", name: "snosi", fullName: "frostyard/snosi", defaultBranch: "main" },
  ])),
  createIssue: vi.fn(() => Promise.resolve(42)),
  addLabel: vi.fn(() => Promise.resolve()),
  getIssueBody: vi.fn(() => Promise.resolve("Issue body text")),
  getIssueComments: vi.fn(() => Promise.resolve([
    { id: 1, body: "A comment", login: "user1" },
  ])),
}));

vi.mock("./claude.js", () => ({
  queueStatus: vi.fn(() => ({ pending: 0, active: 0 })),
  enqueue: vi.fn((fn: () => Promise<string>) => fn()),
  runClaude: vi.fn(() => Promise.resolve("This issue is about fixing a bug.")),
}));
```

- [ ] **Step 2: Add test cases for `issue` command**

Test cases:
- Creates issue with valid repo and title, replies with confirmation
- Replies with usage when missing repo
- Replies with usage when missing title
- Replies with "Unknown repo" when repo not in listRepos

- [ ] **Step 3: Add test cases for `look` command**

Test cases:
- Fetches issue data and calls Claude, replies with summary
- Replies with usage for invalid format (no `#`)
- Replies with "Unknown repo" for bad repo
- Truncates long Claude responses to 1900 chars

- [ ] **Step 4: Add test cases for `assign` command**

Test cases:
- Calls addLabel with "Refined", replies with confirmation
- Replies with usage for invalid format
- Replies with "Unknown repo" for bad repo

- [ ] **Step 5: Add test cases for helpers**

Test `parseRepoRef` and `resolveRepo` if they're exported (or test them through the commands).

- [ ] **Step 6: Update existing tests for handleCommand signature change**

The existing tests for `trigger`, `pause`, `resume` now need to pass args as an array instead of a single param. Update accordingly.

- [ ] **Step 7: Run tests**

```bash
npx vitest run src/discord.test.ts
```

Expected: All tests pass.

- [ ] **Step 8: Commit**

```bash
git add src/discord.test.ts
git commit -m "test: add tests for discord github commands"
```

---

### Task 3: Documentation and Final Verification

**Files:**
- Modify: `yeti/discord-setup.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update yeti/discord-setup.md**

Add the 3 new commands to the commands reference section. Note that repos use short names (e.g., `snosi` not `frostyard/snosi`).

- [ ] **Step 2: Update CLAUDE.md**

Update the `discord.ts` description to mention GitHub commands.

- [ ] **Step 3: Build and test**

```bash
npm run build && npm test
```

Expected: Both pass.

- [ ] **Step 4: Commit**

```bash
git add yeti/discord-setup.md CLAUDE.md
git commit -m "docs: add github commands to discord documentation"
```
