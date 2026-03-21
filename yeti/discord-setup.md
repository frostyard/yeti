# Discord Bot Setup

The Discord integration lets you receive Yeti notifications and control jobs directly from a private Discord channel.

## Prerequisites

Before starting, confirm you have the following ready:

- A working Yeti installation (systemd service running, `gh` and `claude` authenticated)
- A Discord account with permission to create applications and manage a server

---

## Step 1 — Create a Discord Application

1. Go to [https://discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application**
3. Give it a name (e.g. `Yeti`)
4. Click **Create**

---

## Step 2 — Create a Bot

1. In the left sidebar, navigate to **Bot**
2. Click **Add Bot** (then confirm)

---

## Step 3 — Enable Message Content Intent

Still on the **Bot** page, scroll down to **Privileged Gateway Intents** and enable:

- **Message Content Intent**

This is required for Yeti to read command messages.

---

## Step 4 — Copy the Bot Token

1. On the **Bot** page, click **Reset Token** (confirm if prompted)
2. Copy the token that appears

Set it as `discordBotToken` in `~/.yeti/config.json`:

```json
{
  "discordBotToken": "your-token-here"
}
```

Or as an environment variable in `~/.yeti/env`:

```bash
YETI_DISCORD_BOT_TOKEN=your-token-here
```

Environment variables take priority over the config file.

> **Security note:** Treat this token like a password. Anyone with access to it can control your bot.

---

## Step 5 — Generate an Invite URL

1. In the left sidebar, navigate to **OAuth2** → **URL Generator**
2. Under **Scopes**, select: `bot`
3. Under **Bot Permissions**, select:
   - `Send Messages`
   - `Read Message History`
4. Copy the generated URL at the bottom of the page

---

## Step 6 — Invite the Bot to Your Server

1. Open the copied URL in a browser
2. Select your Discord server from the dropdown
3. Click **Authorize**

---

## Step 7 — Create a Private Channel

1. In your Discord server, create a new text channel (e.g. `#yeti`)
2. Set it to **private** (only visible to specific roles/members)
3. Add the bot to the channel's member list so it can read and send messages

---

## Step 8 — Get the Channel ID

1. Open **User Settings** → **Advanced** → enable **Developer Mode**
2. Right-click the `#yeti` channel → **Copy Channel ID**

Set it in `~/.yeti/config.json`:

```json
{
  "discordChannelId": "123456789012345678"
}
```

Or in `~/.yeti/env`:

```bash
YETI_DISCORD_CHANNEL_ID=123456789012345678
```

---

## Step 9 — Set Allowed Users

Only users listed here can issue commands to Yeti.

1. Right-click your username in Discord → **Copy User ID** (requires Developer Mode from Step 8)
2. Repeat for any additional users

Set in `~/.yeti/config.json`:

```json
{
  "discordAllowedUsers": ["111111111111111111", "222222222222222222"]
}
```

Or in `~/.yeti/env` (comma-separated):

```bash
YETI_DISCORD_ALLOWED_USERS=111111111111111111,222222222222222222
```

---

## Step 10 — Restart Yeti

```bash
sudo systemctl restart yeti
```

Check the logs to confirm the bot connected:

```bash
sudo journalctl -u yeti -f
```

You should see a line like:

```
[discord] Connected as Yeti#1234
```

---

## Available Commands

Send these commands in the `#yeti` channel. Only users in `discordAllowedUsers` are permitted.

| Command | Description |
|---|---|
| `!yeti status` | Show overview: job count, running, paused, queue depth, uptime |
| `!yeti jobs` | List all jobs with their current state (idle / running / paused) |
| `!yeti trigger <job>` | Manually trigger a job by name (e.g. `!yeti trigger issue-worker`) |
| `!yeti pause <job>` | Pause a job so it skips its scheduled ticks |
| `!yeti resume <job>` | Resume a paused job |
| `!yeti issue <repo> <title>` | Create a GitHub issue (e.g. `!yeti issue snosi Fix the login bug`) |
| `!yeti look <repo>#<number>` | Summarize an issue or PR via Claude (e.g. `!yeti look snosi#42`) |
| `!yeti assign <repo>#<number>` | Label an issue as Refined for Yeti to pick up (e.g. `!yeti assign snosi#42`) |
| `!yeti recent [job]` | Show recent actions per job (optional filter by job name) |
| `!yeti help` | Show the command list |

---

## Operational Checklist

- [ ] `discordBotToken` is set (config or env)
- [ ] `discordChannelId` is set (config or env)
- [ ] `discordAllowedUsers` contains your user ID
- [ ] Bot has been invited to the server and added to the private channel
- [ ] **Message Content Intent** is enabled in the Developer Portal
- [ ] Yeti service restarted and logs show `[discord] Connected`
- [ ] Test command `!yeti status` returns a reply

---

## Troubleshooting

### Bot does not connect

- Verify `discordBotToken` is correct and has not expired (reset it in the Developer Portal if needed)
- Confirm **Message Content Intent** is enabled under **Bot** → **Privileged Gateway Intents**

### Commands are ignored

- Confirm your Discord user ID is in `discordAllowedUsers`
- Confirm the message is sent in the channel matching `discordChannelId`
- Commands must start with `!yeti` (case-sensitive)

### Bot can see the channel but cannot send messages

- Check the channel's permission overrides — the bot role needs **Send Messages** and **View Channel**

### Notifications are not arriving

- Confirm the bot is online (green status in the member list)
- Check `GET /status` on the Yeti HTTP server — the `discord` field should show `configured: true` and `connected: true`

---

## Security Notes

- Only users in `discordAllowedUsers` can trigger commands. All other messages in the channel are silently ignored.
- Use a private channel to prevent other server members from seeing Yeti notifications.
- The bot token grants full control of the bot. Store it in `~/.yeti/env` (not in `config.json` if that file is version-controlled) and restrict file permissions: `chmod 600 ~/.yeti/env`.
