# Phase 3a: Discord Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Discord bot to Yeti for notifications and job control commands from allowlisted users.

**Architecture:** New `src/discord.ts` module using discord.js for bot connection, `src/notify.ts` fan-out module replacing direct `slack.notify()` calls. Discord config added to `config.ts`. Commands parsed from `!yeti` prefixed messages. Dashboard shows Discord status.

**Tech Stack:** Node.js 22, TypeScript, discord.js, Vitest

**Spec:** `.superpowers/specs/2026-03-20-phase3a-discord-integration-design.md`

---

### Task 1: Add discord.js Dependency and Create Branch

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Create feature branch**

```bash
git checkout -b feat/discord-integration
```

- [ ] **Step 2: Install discord.js**

```bash
npm install discord.js
```

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add discord.js dependency"
```

---

### Task 2: Add Discord Config to config.ts

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add ConfigFile properties**

Add to the `ConfigFile` interface (after `openaiApiKey`):

```typescript
discordBotToken?: string;
discordChannelId?: string;
discordAllowedUsers?: string[];
```

- [ ] **Step 2: Add loadConfig() parsing**

Add after the `openaiApiKey` assignment (around line 133):

```typescript
const discordBotToken =
  process.env["YETI_DISCORD_BOT_TOKEN"] ?? file.discordBotToken ?? "";

const discordChannelId =
  process.env["YETI_DISCORD_CHANNEL_ID"] ?? file.discordChannelId ?? "";

const discordAllowedUsers = process.env["YETI_DISCORD_ALLOWED_USERS"]
  ? process.env["YETI_DISCORD_ALLOWED_USERS"].split(",").map((s) => s.trim()).filter(Boolean)
  : file.discordAllowedUsers ?? [];
```

Add `discordBotToken`, `discordChannelId`, `discordAllowedUsers` to the return statement.

- [ ] **Step 3: Add exports**

```typescript
// Immutable — requires restart (bot connection)
export const DISCORD_BOT_TOKEN = config.discordBotToken;
export const DISCORD_CHANNEL_ID = config.discordChannelId;
// Live-reloadable
export let DISCORD_ALLOWED_USERS: readonly string[] = config.discordAllowedUsers;
```

- [ ] **Step 4: Add reloadConfig() assignment for allowedUsers**

In `reloadConfig()`, add:

```typescript
DISCORD_ALLOWED_USERS = fresh.discordAllowedUsers;
```

- [ ] **Step 5: Add discordBotToken to SENSITIVE_KEYS**

Add `"discordBotToken"` to the `SENSITIVE_KEYS` set.

- [ ] **Step 6: Verify build**

```bash
npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add src/config.ts
git commit -m "feat: add discord config properties"
```

---

### Task 3: Create notify.ts Fan-Out Module

**Files:**
- Create: `src/notify.ts`
- Create: `src/notify.test.ts`
- Modify: `src/log.ts`
- Modify: `src/github.ts`
- Modify: `src/whatsapp.ts`
- Modify: `src/jobs/issue-auditor.ts`
- Modify: `src/github.test.ts`
- Modify: `src/github.hasValidLGTM.test.ts`
- Modify: `src/whatsapp.test.ts`
- Modify: `src/jobs/issue-auditor.test.ts`

- [ ] **Step 1: Create src/notify.ts**

```typescript
import { notify as slackNotify } from "./slack.js";

export function notify(text: string): void {
  slackNotify(text);
  // Discord notify will be added in a later task
}
```

Note: We create this without the Discord import first since `discord.ts` doesn't exist yet. We'll add the Discord call in Task 5 after creating the module.

- [ ] **Step 2: Create src/notify.test.ts**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./slack.js", () => ({
  notify: vi.fn(),
}));

import { notify } from "./notify.js";
import { notify as slackNotify } from "./slack.js";

describe("notify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards to slack", () => {
    notify("test message");
    expect(slackNotify).toHaveBeenCalledWith("test message");
  });
});
```

- [ ] **Step 3: Run test**

```bash
npx vitest run src/notify.test.ts
```

Expected: PASS

- [ ] **Step 4: Migrate callers from slack.notify to notify.notify**

In each of these 4 files, change `import { notify } from "./slack.js"` to `import { notify } from "./notify.js"`:

- `src/log.ts` (line 2)
- `src/github.ts` — find the `import { notify } from "./slack.js"` line
- `src/whatsapp.ts` — find the `import { notify } from "./slack.js"` line
- `src/jobs/issue-auditor.ts` — find the `import { notify } from "../slack.js"` line → change to `import { notify } from "../notify.js"`

- [ ] **Step 5: Migrate test mocks**

In each of these 4 test files, change the `vi.mock` for slack.js `notify` to mock `notify.js` instead:

- `src/github.test.ts` — change `vi.mock("./slack.js", ...)` to `vi.mock("./notify.js", ...)`
- `src/github.hasValidLGTM.test.ts` — same change
- `src/whatsapp.test.ts` — same change
- `src/jobs/issue-auditor.test.ts` — change `vi.mock("../slack.js", ...)` to `vi.mock("../notify.js", ...)`

Also update any `import { notify } from "./slack.js"` to `import { notify } from "./notify.js"` in these test files if they import `notify` directly.

- [ ] **Step 6: Verify all tests pass**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/notify.ts src/notify.test.ts src/log.ts src/github.ts src/whatsapp.ts src/jobs/issue-auditor.ts src/github.test.ts src/github.hasValidLGTM.test.ts src/whatsapp.test.ts src/jobs/issue-auditor.test.ts
git commit -m "feat: create notify.ts fan-out module, migrate callers from slack"
```

---

### Task 4: Create discord.ts Module

**Files:**
- Create: `src/discord.ts`
- Create: `src/discord.test.ts`

- [ ] **Step 1: Create src/discord.ts**

```typescript
import { Client, GatewayIntentBits, type Message, type TextChannel } from "discord.js";
import { DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, DISCORD_ALLOWED_USERS } from "./config.js";
import * as log from "./log.js";
import { queueStatus } from "./claude.js";
import type { Scheduler } from "./scheduler.js";

let client: Client | null = null;
let channel: TextChannel | null = null;
let connected = false;
let lastResult: "ok" | "error" | null = null;
let schedulerRef: Scheduler | null = null;
let startedAt: Date | null = null;

export function isDiscordConfigured(): boolean {
  return !!DISCORD_BOT_TOKEN && !!DISCORD_CHANNEL_ID;
}

export function discordStatus(): {
  configured: boolean;
  connected: boolean;
  lastResult: "ok" | "error" | null;
} {
  return { configured: isDiscordConfigured(), connected, lastResult };
}

export function notify(text: string): void {
  if (!channel || !connected) {
    return;
  }

  channel.send(text)
    .then(() => { lastResult = "ok"; })
    .catch((err) => {
      lastResult = "error";
      console.log(`[discord] notify failed: ${err}`);
    });
}

export async function start(scheduler: Scheduler): Promise<void> {
  if (!isDiscordConfigured()) return;

  schedulerRef = scheduler;
  startedAt = new Date();

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on("ready", async () => {
    try {
      const ch = await client!.channels.fetch(DISCORD_CHANNEL_ID);
      if (ch?.isTextBased()) {
        channel = ch as TextChannel;
        connected = true;
        log.info(`[discord] Connected as ${client!.user?.tag}`);
      } else {
        log.error(`[discord] Channel ${DISCORD_CHANNEL_ID} not found or not a text channel`);
      }
    } catch (err) {
      log.error(`[discord] Failed to fetch channel ${DISCORD_CHANNEL_ID}: ${err}`);
    }
  });

  client.on("shardDisconnect", () => {
    connected = false;
    channel = null;
    log.warn("[discord] Disconnected");
  });

  client.on("shardReady", async () => {
    try {
      const ch = await client!.channels.fetch(DISCORD_CHANNEL_ID);
      if (ch?.isTextBased()) {
        channel = ch as TextChannel;
        connected = true;
        log.info("[discord] Reconnected");
      }
    } catch {
      // best effort on reconnect
    }
  });

  client.on("error", (err) => {
    lastResult = "error";
    // Use console.log to avoid recursive notify (log.error → notify → discord)
    console.log(`[discord] Client error: ${err.message}`);
  });

  client.on("messageCreate", (message: Message) => {
    if (message.author.bot) return;
    if (message.channelId !== DISCORD_CHANNEL_ID) return;
    if (!message.content.startsWith("!yeti")) return;
    if (!DISCORD_ALLOWED_USERS.includes(message.author.id)) return;

    const rest = message.content.slice("!yeti".length).trim();
    const args = rest ? rest.split(/\s+/) : ["help"];
    const command = args[0];
    const param = args[1];

    handleCommand(command, param, message).catch((err) => {
      message.reply(`Error: ${err.message}`).catch(() => {});
    });
  });

  await client.login(DISCORD_BOT_TOKEN);
}

export async function stop(): Promise<void> {
  if (client) {
    connected = false;
    channel = null;
    await client.destroy();
    client = null;
    schedulerRef = null;
  }
}

async function handleCommand(command: string, param: string | undefined, message: Message): Promise<void> {
  if (!schedulerRef) return;

  switch (command) {
    case "status": {
      const states = schedulerRef.jobStates();
      const paused = schedulerRef.pausedJobs();
      const running = [...states.values()].filter(Boolean).length;
      const queue = queueStatus();
      const uptimeMs = startedAt ? Date.now() - startedAt.getTime() : 0;
      const uptimeStr = formatUptime(uptimeMs);
      await message.reply(
        `**Status:** ${states.size} jobs, ${running} running, ${paused.size} paused\n**Queue:** ${queue.pending} pending, ${queue.active} active\n**Uptime:** ${uptimeStr}`
      );
      break;
    }

    case "trigger": {
      if (!param) { await message.reply("Usage: `!yeti trigger <job-name>`"); return; }
      const result = schedulerRef.triggerJob(param);
      if (result === "started") await message.reply(`Triggered **${param}**`);
      else if (result === "already-running") await message.reply(`**${param}** is already running`);
      else await message.reply(`Unknown job: **${param}**`);
      break;
    }

    case "pause": {
      if (!param) { await message.reply("Usage: `!yeti pause <job-name>`"); return; }
      const ok = schedulerRef.pauseJob(param);
      await message.reply(ok ? `Paused **${param}**` : `Unknown job: **${param}**`);
      break;
    }

    case "resume": {
      if (!param) { await message.reply("Usage: `!yeti resume <job-name>`"); return; }
      const ok = schedulerRef.resumeJob(param);
      await message.reply(ok ? `Resumed **${param}**` : `Unknown job: **${param}**`);
      break;
    }

    case "jobs": {
      const states = schedulerRef.jobStates();
      const paused = schedulerRef.pausedJobs();
      const lines = [...states.entries()].map(([name, running]) => {
        const status = paused.has(name) ? "paused" : running ? "running" : "idle";
        return `• **${name}**: ${status}`;
      });
      await message.reply(lines.join("\n") || "No jobs registered");
      break;
    }

    case "help": {
      await message.reply(
        "**Yeti Commands:**\n" +
        "`!yeti status` — show overview\n" +
        "`!yeti jobs` — list all jobs\n" +
        "`!yeti trigger <job>` — trigger a job\n" +
        "`!yeti pause <job>` — pause a job\n" +
        "`!yeti resume <job>` — resume a job\n" +
        "`!yeti help` — this message"
      );
      break;
    }

    default:
      await message.reply(`Unknown command: **${command}**. Try \`!yeti help\``);
  }
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
```

- [ ] **Step 2: Create src/discord.test.ts**

Test the module with discord.js fully mocked. Key test cases:

- `isDiscordConfigured()` returns false when token/channel empty
- `isDiscordConfigured()` returns true when both set
- `discordStatus()` returns correct shape
- `notify()` is no-op when not connected
- `handleCommand` dispatches correctly for each command (status, trigger, pause, resume, jobs, help, unknown)
- Messages from non-allowlisted users are ignored
- Messages not starting with `!yeti` are ignored
- Bot messages are ignored

Mock discord.js `Client` class, mock config imports. Use `vi.mock` at module level.

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/discord.test.ts
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/discord.ts src/discord.test.ts
git commit -m "feat: create discord.ts module with bot, notifications, and commands"
```

---

### Task 5: Wire Discord into notify.ts

**Files:**
- Modify: `src/notify.ts`
- Modify: `src/notify.test.ts`

- [ ] **Step 1: Add Discord notify to notify.ts**

Update `src/notify.ts`:

```typescript
import { notify as slackNotify } from "./slack.js";
import { notify as discordNotify } from "./discord.js";

export function notify(text: string): void {
  slackNotify(text);
  discordNotify(text);
}
```

- [ ] **Step 2: Update notify.test.ts**

Add Discord mock and test:

```typescript
vi.mock("./discord.js", () => ({
  notify: vi.fn(),
}));
```

Add import and test case:

```typescript
import { notify as discordNotify } from "./discord.js";

it("forwards to discord", () => {
  notify("test message");
  expect(discordNotify).toHaveBeenCalledWith("test message");
});
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/notify.test.ts
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/notify.ts src/notify.test.ts
git commit -m "feat: wire discord into notify fan-out"
```

---

### Task 6: Integrate Discord into main.ts (Startup & Shutdown)

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Add imports**

Add after the WhatsApp imports:

```typescript
import * as discord from "./discord.js";
import { isDiscordConfigured } from "./discord.js";
```

- [ ] **Step 2: Add Discord startup**

Add after the WhatsApp gateway block (after line 241):

```typescript
// ── Discord bot ──

if (isDiscordConfigured()) {
  discord.start(scheduler).catch((err) => {
    log.error(`[discord] Failed to start: ${err}`);
    reportError("discord:start", "Discord bot failed to start", err).catch(() => {});
  });
  log.info("Discord bot enabled");
}
```

- [ ] **Step 3: Add Discord shutdown**

In the `shutdown()` function, add after the WhatsApp stop (after line 255):

```typescript
if (isDiscordConfigured()) {
  await discord.stop();
}
```

- [ ] **Step 4: Verify build**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat: integrate discord startup and shutdown in main.ts"
```

---

### Task 7: Dashboard and Config Page Integration

**Files:**
- Modify: `src/pages/layout.ts`
- Modify: `src/pages/dashboard.ts`
- Modify: `src/pages/config.ts`
- Modify: `src/server.ts`
- Modify: `src/server.test.ts`

- [ ] **Step 1: Add discordLabel() to layout.ts**

Add after the existing `whatsappLabel()` function:

```typescript
export function discordLabel(discord: {
  configured: boolean;
  connected: boolean;
  lastResult: "ok" | "error" | null;
}): { text: string; cls: string } {
  if (!discord.configured) return { text: "Not configured", cls: "idle" };
  if (!discord.connected) return { text: "Disconnected", cls: "slack-error" };
  if (discord.lastResult === "error") return { text: "Error", cls: "slack-error" };
  if (discord.lastResult === "ok") return { text: "Connected", cls: "running" };
  return { text: "Connected (untested)", cls: "slack-untested" };
}
```

- [ ] **Step 2: Add Discord status to dashboard.ts**

Add Discord as a parameter to `buildStatusPage()` — insert it after the `email` parameter (position 9, before `runningTasks`). The full signature becomes:

```typescript
export function buildStatusPage(
  version: string,
  uptime: number,
  jobs: Record<string, boolean>,
  queue: { pending: number; active: number },
  slack: { configured: boolean; lastResult: "ok" | "error" | null },
  slackBot: { configured: boolean },
  wa: { configured: boolean; connected: boolean; pairingRequired: boolean },
  email: { configured: boolean; lastCheck: string | null; lastError: string | null },
  discord: { configured: boolean; connected: boolean; lastResult: "ok" | "error" | null },  // NEW
  runningTasks: RunningTaskInfo[],
  // ... rest unchanged
```

Update both call sites in `server.ts` (the `GET /` handler and the `/status` JSON endpoint) to pass `discordStatus()` in the correct position. Add `discordLabel` import from `./layout.js`.

Add HTML row:
```html
<dt>Discord</dt>
<dd id="discord-status" class="${dc.cls}">${dc.text}</dd>
```

Add to the JavaScript polling section to update Discord status on refresh.

- [ ] **Step 3: Add Discord fields to config page**

In `src/pages/config.ts`:

Add to `envMap`:
```typescript
discordBotToken: "YETI_DISCORD_BOT_TOKEN",
discordChannelId: "YETI_DISCORD_CHANNEL_ID",
discordAllowedUsers: "YETI_DISCORD_ALLOWED_USERS",
```

Add a Discord section in the HTML form (after the WhatsApp section):
```html
<h2>Discord</h2>
<label for="discordBotToken">Discord Bot Token</label>
<input type="password" name="discordBotToken" ...>
<div class="field-note">Read-only — requires restart</div>

<label for="discordChannelId">Discord Channel ID</label>
<input type="text" name="discordChannelId" ...>
<div class="field-note">Read-only — requires restart</div>

<label for="discordAllowedUsers">Discord Allowed Users (comma-separated IDs)</label>
<input type="text" name="discordAllowedUsers" ...>
```

- [ ] **Step 4: Update server.ts**

Add import:
```typescript
import { discordStatus } from "./discord.js";
```

Add `discord: discordStatus()` to the `/status` JSON response object.

Add the Discord status parameter to the `buildStatusPage()` call on the dashboard route.

Add Discord POST /config handler params:
```typescript
if (params["discordAllowedUsers"] !== undefined) {
  updates.discordAllowedUsers = params["discordAllowedUsers"].split(",").map(s => s.trim()).filter(Boolean);
}
```

Note: `discordBotToken` and `discordChannelId` are immutable but can still be saved to config for next restart.
```typescript
if (params["discordBotToken"] !== undefined) updates.discordBotToken = params["discordBotToken"];
if (params["discordChannelId"] !== undefined) updates.discordChannelId = params["discordChannelId"];
```

- [ ] **Step 5: Update server.test.ts**

Add `vi.mock("./discord.js", ...)` mock with `discordStatus` returning `{ configured: false, connected: false, lastResult: null }`.

- [ ] **Step 6: Run tests**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/pages/layout.ts src/pages/dashboard.ts src/pages/config.ts src/server.ts src/server.test.ts
git commit -m "feat: add discord status to dashboard and config page"
```

---

### Task 8: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `yeti/OVERVIEW.md`
- Create: `yeti/discord-setup.md`

- [ ] **Step 1: Create yeti/discord-setup.md**

Write a setup guide covering:
1. Create application in Discord Developer Portal
2. Create bot in the Bot section
3. Enable "Message Content Intent" under Privileged Gateway Intents
4. Copy bot token → `YETI_DISCORD_BOT_TOKEN`
5. OAuth2 → URL Generator: scopes `bot`, permissions `Send Messages`, `Read Message History`
6. Invite bot to server using generated URL
7. Create private `#yeti` channel, add bot to it
8. Copy channel ID (Developer Mode → right-click → Copy ID) → `YETI_DISCORD_CHANNEL_ID`
9. Copy user IDs for allowlisted users → `YETI_DISCORD_ALLOWED_USERS`
10. Available commands reference

- [ ] **Step 2: Update CLAUDE.md**

Add `discord.ts` to the core modules list with a one-line description. Add Discord config env vars to any config reference.

- [ ] **Step 3: Update yeti/OVERVIEW.md**

Add Discord to the integrations section. Add Discord config entries to the configuration table. Add `notify.ts` to the module list.

- [ ] **Step 4: Commit**

```bash
git add yeti/discord-setup.md CLAUDE.md yeti/OVERVIEW.md
git commit -m "docs: add discord setup guide and update architecture docs"
```

---

### Task 9: Build, Test, and Final Verification

- [ ] **Step 1: Install dependencies**

```bash
npm ci
```

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: Zero errors.

- [ ] **Step 3: Run all tests**

```bash
npm test
```

Expected: All tests pass.

- [ ] **Step 4: Verify no missed references**

```bash
grep -rn 'from "./slack.js"' src/ --include='*.ts' | grep 'notify'
```

Expected: Only `src/notify.ts` should import `notify` from `slack.js`. No other source files should import `notify` from slack directly.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve remaining issues from discord integration"
```

Only create if fixes were needed.
