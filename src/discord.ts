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
      // Use console.log to avoid recursive notify (log.error → notify → discord)
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
