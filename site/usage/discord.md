# Discord Bot

Yeti's Discord integration lets you manage issues, analyze work, and receive notifications without leaving your chat. It is entirely optional --- Yeti runs fine without it --- but if Discord is where your team already lives, it keeps everything within arm's reach.

## Setup

Three config fields activate the bot:

```json
{
  "discordBotToken": "your-bot-token",
  "discordChannelId": "123456789012345678",
  "discordAllowedUsers": ["your-discord-user-id"]
}
```

| Field | Description |
|---|---|
| `discordBotToken` | Bot token from the Discord developer portal |
| `discordChannelId` | Channel where Yeti posts notifications and listens for commands |
| `discordAllowedUsers` | Array of Discord user IDs permitted to run commands |

### Creating the bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application and add a bot
3. Enable the following **Privileged Gateway Intents**:
    - Guilds
    - Guild Messages
    - Message Content
4. Generate an invite URL with the `bot` scope and `Send Messages` + `Read Message History` permissions
5. Invite the bot to your server
6. Copy the bot token into your Yeti config

!!! note
    The Discord bot connects at startup. Changes to `discordBotToken` or `discordChannelId` require a service restart to take effect. The `discordAllowedUsers` list reloads live.

## Notifications

Yeti posts to your configured channel automatically. You do not need to set anything up beyond the bot itself --- notifications flow as part of normal job activity.

**What Yeti reports:**

- **Issue audit summaries** --- The `issue-auditor` job posts its nightly findings: mislabeled issues, stale items, anomalies across your repos
- **Error reports** --- When something goes wrong, the error reporter sends a summary with deduplication (the same error will not flood your channel)
- **Job activity** --- Notifications for significant work: PRs created, plans produced, CI fixes pushed, reviews addressed, merges completed, and more. Each notification includes a direct GitHub link to the relevant issue or PR.

Notifications are informational. They do not require a response --- just a glance to confirm things are running smoothly, like checking the weather before heading out.

## Commands

All commands use the `!yeti` prefix. Only users listed in `discordAllowedUsers` can run them.

### `!yeti help`

Shows the list of available commands.

### `!yeti issue <repo> <title> [body]`

Create a GitHub issue from Discord.

```
!yeti issue frontend Add dark mode toggle

The settings page needs a dark/light mode switch.
Users have been requesting this in the feedback channel.
```

The first line after the repo name becomes the title. Everything after the first line break becomes the issue body.

**Repo names are short names** scoped to your configured GitHub org. Use `frontend`, not `your-org/frontend`.

### `!yeti look <repo> <issue-number>`

Analyze an issue or PR with Claude and get a summary posted back to Discord.

```
!yeti look api 42
```

Yeti reads the issue, its comments, and the relevant codebase context, then posts an analysis. Useful when you want a quick read on something without opening GitHub.

### `!yeti assign <repo> <issue-number>`

Label an issue as **Refined**, which tells Yeti to start implementation.

```
!yeti assign frontend 15
```

This is the Discord equivalent of adding the **Refined** label on GitHub. Use it when you have already reviewed the plan and want to greenlight implementation from your chat.

### `!yeti for-me`

List all items that need your attention --- issues and PRs with the **Ready** label waiting for a human decision.

```
!yeti for-me
```

Yeti pulls from its queue cache and returns a numbered list with repo, issue number, title, priority flag, and a direct GitHub link for each item. If the queue has not been scanned yet, it asks you to try again in a few minutes.

## Permissions

Only Discord users whose IDs appear in the `discordAllowedUsers` config array can execute commands. Messages from other users are silently ignored.

To find a Discord user ID: enable Developer Mode in Discord settings, then right-click your username and select "Copy User ID."

The `discordAllowedUsers` list reloads live --- you can grant or revoke access without restarting Yeti.
