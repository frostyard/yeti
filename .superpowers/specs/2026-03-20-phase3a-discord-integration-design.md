# Phase 3a: Discord Integration

**Date:** 2026-03-20
**Status:** Approved
**Approach:** discord.js library for bot connection, notifications, and message-based commands

## Overview

Add Discord bot integration to Yeti with two capabilities: outbound notifications (mirroring Slack's `notify()` pattern) and inbound commands from allowlisted users via `!yeti` message prefix. Both Slack and Discord coexist — notifications fan out to whichever services are configured.

## Module Structure

### `src/discord.ts` (new)

Mirrors `src/slack.ts` pattern. Exports:

- **`start(scheduler: Scheduler): Promise<void>`** — connects the discord.js `Client` with intents: `Guilds`, `GuildMessages`, `MessageContent`. Registers the message listener for `!yeti` commands. Requires `scheduler` for job control commands.
- **`stop(): Promise<void>`** — graceful disconnect via `client.destroy()`.
- **`notify(text: string): void`** — sends a message to the configured channel. Fire-and-forget, no throw. Silently no-ops if unconfigured or disconnected. Tracks `lastResult` state.
- **`discordStatus(): { configured: boolean; connected: boolean; lastResult: "ok" | "error" | null }`** — status for dashboard display.
- **`isDiscordConfigured(): boolean`** — true when both `discordBotToken` and `discordChannelId` are non-empty.

The `Client` instance is module-scoped (like `slack.ts`'s state). Connection lifecycle:
- On `ready` event: log success, set connected state
- On `error`/`disconnect`: log, update status, discord.js handles reconnection automatically
- On `messageCreate`: check allowlist, parse `!yeti` commands, dispatch

### `src/notify.ts` (new)

Thin fan-out module:

```typescript
import { notify as slackNotify } from "./slack.js";
import { notify as discordNotify } from "./discord.js";

export function notify(text: string): void {
  slackNotify(text);
  discordNotify(text);
}
```

Both functions are already no-op when their service is unconfigured.

### Caller Migration

These 4 files switch their import from `./slack.js` to `./notify.js`:

- `src/github.ts` — rate limit alerts
- `src/log.ts` — ERROR-level log forwarding
- `src/whatsapp.ts` — pairing state changes
- `src/jobs/issue-auditor.ts` — label fix summaries

Import change: `import { notify } from "./slack.js"` → `import { notify } from "./notify.js"`

### Test File Migration

These test files mock `./slack.js` for the `notify` function and must switch to mocking `./notify.js`:

- `src/github.test.ts`
- `src/github.hasValidLGTM.test.ts`
- `src/whatsapp.test.ts`
- `src/jobs/issue-auditor.test.ts`

## Configuration

### New ConfigFile Properties

```typescript
discordBotToken?: string;
discordChannelId?: string;
discordAllowedUsers?: string[];
```

### Environment Variables

| Property | Env Var | Default |
|----------|---------|---------|
| `discordBotToken` | `YETI_DISCORD_BOT_TOKEN` | `""` |
| `discordChannelId` | `YETI_DISCORD_CHANNEL_ID` | `""` |
| `discordAllowedUsers` | `YETI_DISCORD_ALLOWED_USERS` | `[]` (comma-separated) |

### Config Behavior

- Discord is "configured" when both `discordBotToken` and `discordChannelId` are non-empty.
- `discordAllowedUsers` is independent — if empty, no one can send commands but notifications still work.
- `discordBotToken` added to `SENSITIVE_KEYS` for masking.
- `discordBotToken` and `discordChannelId` are immutable — require restart to change (like `WHATSAPP_ENABLED`). Exported as `const`, not `let`.
- `discordAllowedUsers` is live-reloadable via `reloadConfig()` — exported as `let`.

## Commands

Allowlisted users send `!yeti <command>` in the `#yeti` channel. The bot replies in the same channel.

| Command | Action | Example Response |
|---------|--------|-----------------|
| `!yeti status` | Shows job states, uptime, queue size | "10 jobs running, uptime 2d 4h, queue: 3 items" |
| `!yeti trigger <job>` | Manually triggers a job | "Triggered ci-fixer" |
| `!yeti pause <job>` | Pauses a job | "Paused ci-fixer" |
| `!yeti resume <job>` | Resumes a job | "Resumed ci-fixer" |
| `!yeti jobs` | Lists all jobs with paused/running state | Table of job names and states |
| `!yeti help` | Lists available commands | Command reference |

### Auth & Security

- Messages from non-allowlisted users are silently ignored (no response).
- Messages not starting with `!yeti` are ignored.
- Invalid commands get a short error reply.
- Allowlist uses Discord user IDs (numeric strings), not usernames.
- The command handler is a simple string-match dispatcher — no framework needed.

### Scheduler Integration

Commands call into the existing `Scheduler` API:
- `status` → `scheduler.jobStates()`, `scheduler.pausedJobs()`
- `trigger <job>` → `scheduler.triggerJob(name)`
- `pause <job>` → `scheduler.pauseJob(name)`
- `resume <job>` → `scheduler.resumeJob(name)`
- `jobs` → `scheduler.jobStates()`, `scheduler.pausedJobs()`, `scheduler.jobScheduleInfo()`

The `Scheduler` instance is passed to `discord.start()` at initialization.

## Dashboard Integration

### Status Display

Add a Discord status row on the dashboard alongside Slack:

```html
<dt>Discord</dt>
<dd id="discord-status" class="${cls}">${text}</dd>
```

States: "Not configured" / "Connected" / "Disconnected" / "Error"

### `/status` JSON Endpoint

Add `discord` field:

```typescript
discord: discordStatus(),  // { configured, connected, lastResult }
```

### Server Imports

`src/server.ts` needs new imports:

```typescript
import { discordStatus, isDiscordConfigured } from "./discord.js";
```

Add `discordLabel()` helper to `src/pages/layout.ts` following the existing `slackLabel()`/`whatsappLabel()` pattern, handling the three-field shape (`configured`, `connected`, `lastResult`).

`src/server.test.ts` needs a `vi.mock("./discord.js", ...)` mock.

### Config Page

Add a Discord section to `src/pages/config.ts` with three fields:
- Discord Bot Token (password input, masked)
- Discord Channel ID (text input)
- Discord Allowed Users (text input, comma-separated)

Add to `envMap`:
- `discordBotToken: "YETI_DISCORD_BOT_TOKEN"`
- `discordChannelId: "YETI_DISCORD_CHANNEL_ID"`
- `discordAllowedUsers: "YETI_DISCORD_ALLOWED_USERS"`

### Config POST Handler

Add parsing for Discord fields in `src/server.ts` POST `/config` handler:
- `params["discordAllowedUsers"]` — comma-separated parsing (like `whatsappAllowedNumbers`)

Note: `discordBotToken` and `discordChannelId` are immutable (require restart), so they can be saved to config but won't take effect until restart. The config page should show a "requires restart" note on these fields.

## Startup & Shutdown

### Startup (`main.ts`)

Discord starts after the scheduler is created, similar to WhatsApp:

```typescript
if (isDiscordConfigured()) {
  discord.start(scheduler).catch(err => {
    log.error(`[discord] Failed to start: ${err}`);
    reportError("discord:start", "Discord bot failed to start", err).catch(() => {});
  });
}
```

### Shutdown (`main.ts`)

`discord.stop()` called conditionally in the shutdown handler (like WhatsApp):

```typescript
if (isDiscordConfigured()) {
  await discord.stop();
}
```

## Dependencies

- Add `discord.js` npm package (latest stable)

## Bot Setup Guide

The documentation should include setup instructions:

1. Go to Discord Developer Portal, create a new Application
2. Navigate to Bot section, create a bot
3. Enable "Message Content Intent" under Privileged Gateway Intents
4. Copy the bot token → set as `YETI_DISCORD_BOT_TOKEN`
5. Navigate to OAuth2 → URL Generator, select scopes: `bot`, permissions: `Send Messages`, `Read Message History`
6. Use generated URL to invite bot to your server
7. Create a private `#yeti` channel, add the bot to it
8. Copy the channel ID (Developer Mode → right-click channel → Copy ID) → set as `YETI_DISCORD_CHANNEL_ID`
9. Copy Discord user IDs for allowlisted users → set as `YETI_DISCORD_ALLOWED_USERS`

## Testing

- `src/discord.test.ts` — unit tests with mocked discord.js Client
- `src/notify.test.ts` — unit tests verifying fan-out to both Slack and Discord
- Mock the discord.js module at the module level, same pattern as other test files
- Test command parsing, allowlist enforcement, error handling, status reporting

## Scope Boundaries

**In scope:**
- `discord.js` dependency
- `src/discord.ts` module (connect, notify, commands, status)
- `src/notify.ts` module (fan-out to Slack + Discord)
- Config: `discordBotToken`, `discordChannelId`, `discordAllowedUsers`
- 6 commands: status, trigger, pause, resume, jobs, help
- Dashboard Discord status row
- Startup/shutdown integration in main.ts
- Config page Discord section
- Bot setup guide in docs
- Update CLAUDE.md, yeti/OVERVIEW.md
- Tests for discord.ts and notify.ts

**Out of scope (Phase 3b):**
- GitHub operations via Discord commands
- Free-form message handling (create issues from messages)
- Replacing Slack entirely (both coexist)
- Discord embeds or rich formatting (plain text for now)
