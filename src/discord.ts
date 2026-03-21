import { Client, GatewayIntentBits, type Message, type TextChannel } from "discord.js";
import { DISCORD_BOT_TOKEN, DISCORD_CHANNEL_ID, DISCORD_ALLOWED_USERS, GITHUB_OWNERS } from "./config.js";
import * as log from "./log.js";
import * as gh from "./github.js";
import { queueStatus, enqueue, runClaude } from "./claude.js";
import type { Scheduler } from "./scheduler.js";

let client: Client | null = null;
let channel: TextChannel | null = null;
let connected = false;
let lastResult: "ok" | "error" | null = null;
let schedulerRef: Scheduler | null = null;
let startedAt: Date | null = null;
let readyResolve: (() => void) | null = null;
let readyPromise: Promise<void> | null = null;

export function isDiscordConfigured(): boolean {
  return !!DISCORD_BOT_TOKEN && !!DISCORD_CHANNEL_ID;
}

export function ready(): Promise<void> {
  if (!isDiscordConfigured()) return Promise.resolve();
  if (!readyPromise) return Promise.reject(new Error("Discord not started"));
  return Promise.race([
    readyPromise,
    new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("Discord connection timeout")), 10_000)
    ),
  ]);
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
  readyPromise = new Promise<void>((resolve) => { readyResolve = resolve; });

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
        lastResult = "ok";
        readyResolve?.();
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
        lastResult = "ok";
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
    const words = rest ? rest.split(/\s+/) : ["help"];
    const command = words[0];
    const commandArgs = words.slice(1);

    handleCommand(command, commandArgs, message).catch((err) => {
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
    readyPromise = null;
    readyResolve = null;
  }
}

function resolveRepo(shortName: string): string {
  if (GITHUB_OWNERS.length === 0) {
    throw new Error("GITHUB_OWNERS is not configured");
  }
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

async function handleCommand(command: string, args: string[], message: Message): Promise<void> {
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
      const param = args[0];
      if (!param) { await message.reply("Usage: `!yeti trigger <job-name>`"); return; }
      const result = schedulerRef.triggerJob(param);
      if (result === "started") await message.reply(`Triggered **${param}**`);
      else if (result === "already-running") await message.reply(`**${param}** is already running`);
      else await message.reply(`Unknown job: **${param}**`);
      break;
    }

    case "pause": {
      const param = args[0];
      if (!param) { await message.reply("Usage: `!yeti pause <job-name>`"); return; }
      const ok = schedulerRef.pauseJob(param);
      await message.reply(ok ? `Paused **${param}**` : `Unknown job: **${param}**`);
      break;
    }

    case "resume": {
      const param = args[0];
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
