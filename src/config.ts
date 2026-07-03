import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import type { Autonomy } from "./policy.js";

const AUTONOMY_TIERS = ["advisory", "issues", "pr", "automerge"] as const satisfies readonly Autonomy[];
// Compile-time guard: if a tier is added to the Autonomy union but not to
// AUTONOMY_TIERS above, this assignment fails to type-check.
type _TierListComplete = Autonomy extends (typeof AUTONOMY_TIERS)[number] ? true : ["AUTONOMY_TIERS missing a tier in the Autonomy union"];
const _tierListComplete: _TierListComplete = true;
void _tierListComplete;

function coerceAutonomy(value: unknown, context: string): Autonomy {
  if (typeof value === "string" && (AUTONOMY_TIERS as readonly string[]).includes(value)) {
    return value as Autonomy;
  }
  if (value !== undefined) {
    console.warn(`[WARN] invalid autonomy "${String(value)}" for ${context} — using "pr"`);
  }
  return "pr";
}

export const WORK_DIR = path.join(os.homedir(), ".yeti");

export const DB_PATH = path.join(WORK_DIR, "yeti.db");

export const CONFIG_PATH = path.join(WORK_DIR, "config.json");

export const LABELS = {
  refined: "Refined",
  ready: "Ready",
  priority: "Priority",
  inReview: "In Review",
  needsRefinement: "Needs Refinement",
  needsPlanReview: "Needs Plan Review",
} as const;

export const LABEL_SPECS: Record<string, { color: string; description: string }> = {
  "Refined":              { color: "0075ca", description: "Issue is ready for yeti to implement" },
  "Ready":                { color: "0e8a16", description: "Yeti has finished — needs human attention" },
  "Priority":             { color: "d93f0b", description: "High-priority — processed first in all Yeti queues" },
  "In Review":            { color: "fbca04", description: "Issue has an open PR being reviewed" },
  "Needs Refinement":     { color: "d876e3", description: "Issue needs an AI-generated implementation plan" },
  "Needs Plan Review":    { color: "c5def5", description: "Plan awaiting adversarial AI review" },
};

/** Labels that were previously managed by Yeti and can be cleaned up as stale. */
export const LEGACY_LABELS = new Set([
  "Plan Produced",
  "Reviewed",
  "prod-report",
  "investigated",
  "yeti-mergeable",
  "yeti-error",
]);

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Repo {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
}

/** Resolve the autonomy tier for a repo: per-repo map > instance default. Must stay
 *  identical to fullNameAutonomy in capability.ts — both resolvers exist only because
 *  one call site has a Repo object and the other only a fullName. */
export function repoAutonomy(repo: Repo): Autonomy {
  return AUTONOMY_MAP[repo.fullName] ?? DEFAULT_AUTONOMY;
}

export interface ConfigFile {
  githubOwners?: string[];
  selfRepo?: string;
  port?: number;
  discordBotToken?: string;
  discordChannelId?: string;
  discordAllowedUsers?: string[];
  authToken?: string;
  maxClaudeWorkers?: number;
  claudeTimeoutMs?: number;
  jobAi?: Record<string, { backend?: "claude" | "copilot" | "codex"; model?: string }>;
  maxCopilotWorkers?: number;
  copilotTimeoutMs?: number;
  maxCodexWorkers?: number;
  codexTimeoutMs?: number;
  intervals?: {
    issueWorkerMs?: number;
    issueRefinerMs?: number;
    ciFixerMs?: number;
    reviewAddresserMs?: number;
    autoMergerMs?: number;
    triageYetiErrorsMs?: number;
    planReviewerMs?: number;
  };
  schedules?: {
    docMaintainerHour?: number;
    repoStandardsHour?: number;
    improvementIdentifierHour?: number;
    issueAuditorHour?: number;
    mkdocsUpdateHour?: number;
    promptEvaluatorHour?: number;
    learningConsolidatorHour?: number;
  };
  logLevel?: LogLevel;
  logRetentionDays?: number;
  logRetentionPerJob?: number;
  pausedJobs?: string[];
  skippedItems?: Array<{ repo: string; number: number }>;
  prioritizedItems?: Array<{ repo: string; number: number }>;
  allowedRepos?: string[];
  includeForks?: boolean;
  enabledJobs?: string[];
  reviewLoop?: boolean;
  maxPlanRounds?: number;
  learningsPendingThreshold?: number;
  queueScanIntervalMs?: number;
  githubAppId?: string;
  githubAppInstallationId?: string;
  githubAppPrivateKeyPath?: string;
  githubAppClientId?: string;
  githubAppClientSecret?: string;
  externalUrl?: string;
  webhookSecret?: string;
  defaultAutonomy?: Autonomy;
  autonomy?: Record<string, Autonomy>;
}

function loadConfig() {
  let file: ConfigFile = {};
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    file = JSON.parse(raw) as ConfigFile;
  } catch {
    // No config file or invalid JSON — use defaults + env vars
  }

  const githubOwners = process.env["YETI_GITHUB_OWNERS"]
    ? process.env["YETI_GITHUB_OWNERS"].split(",").map((s) => s.trim())
    : file.githubOwners ?? ["frostyard"];

  const selfRepo =
    process.env["YETI_SELF_REPO"] ?? file.selfRepo ?? "frostyard/yeti";

  const port = parseInt(
    process.env["PORT"] ?? String(file.port ?? 9384),
    10,
  );

  const intervals = {
    issueWorkerMs: file.intervals?.issueWorkerMs ?? 5 * 60 * 1000,
    issueRefinerMs: file.intervals?.issueRefinerMs ?? 5 * 60 * 1000,
    ciFixerMs: file.intervals?.ciFixerMs ?? 10 * 60 * 1000,
    reviewAddresserMs: file.intervals?.reviewAddresserMs ?? 5 * 60 * 1000,
    autoMergerMs: file.intervals?.autoMergerMs ?? 10 * 60 * 1000,
    triageYetiErrorsMs: file.intervals?.triageYetiErrorsMs ?? 10 * 60 * 1000,
    planReviewerMs: file.intervals?.planReviewerMs ?? 10 * 60 * 1000,
  };

  const schedules = {
    docMaintainerHour: file.schedules?.docMaintainerHour ?? 1, // 1 AM local time
    repoStandardsHour: file.schedules?.repoStandardsHour ?? 2, // 2 AM local time
    improvementIdentifierHour: file.schedules?.improvementIdentifierHour ?? 3, // 3 AM local time
    issueAuditorHour: file.schedules?.issueAuditorHour ?? 5, // 5 AM local time
    mkdocsUpdateHour: file.schedules?.mkdocsUpdateHour ?? 4, // 4 AM local time
    promptEvaluatorHour: file.schedules?.promptEvaluatorHour ?? 0, // midnight local time
    learningConsolidatorHour: file.schedules?.learningConsolidatorHour ?? 6, // 6 AM local time
  };

  const discordBotToken =
    process.env["YETI_DISCORD_BOT_TOKEN"] ?? file.discordBotToken ?? "";

  const discordChannelId =
    process.env["YETI_DISCORD_CHANNEL_ID"] ?? file.discordChannelId ?? "";

  const discordAllowedUsers = process.env["YETI_DISCORD_ALLOWED_USERS"]
    ? process.env["YETI_DISCORD_ALLOWED_USERS"].split(",").map((s) => s.trim()).filter(Boolean)
    : file.discordAllowedUsers ?? [];

  const authToken =
    process.env["YETI_AUTH_TOKEN"] ?? file.authToken ?? "";

  const parsedMaxClaudeWorkers = parseInt(
    process.env["YETI_MAX_CLAUDE_WORKERS"] ?? String(file.maxClaudeWorkers ?? 2),
    10,
  );
  const maxClaudeWorkers =
    Number.isFinite(parsedMaxClaudeWorkers) && parsedMaxClaudeWorkers >= 0
      ? parsedMaxClaudeWorkers
      : 2;

  const parsedClaudeTimeoutMs = parseInt(
    process.env["YETI_CLAUDE_TIMEOUT_MS"] ?? String(file.claudeTimeoutMs ?? 20 * 60 * 1000),
    10,
  );
  const claudeTimeoutMs = Number.isFinite(parsedClaudeTimeoutMs)
    ? Math.max(60_000, parsedClaudeTimeoutMs)
    : 20 * 60 * 1000;

  const parsedMaxCopilotWorkers = parseInt(
    process.env["YETI_MAX_COPILOT_WORKERS"] ?? String(file.maxCopilotWorkers ?? 1),
    10,
  );
  const maxCopilotWorkers =
    Number.isFinite(parsedMaxCopilotWorkers) && parsedMaxCopilotWorkers >= 0
      ? parsedMaxCopilotWorkers
      : 1;

  const parsedCopilotTimeoutMs = parseInt(
    process.env["YETI_COPILOT_TIMEOUT_MS"] ?? String(file.copilotTimeoutMs ?? 20 * 60 * 1000),
    10,
  );
  const copilotTimeoutMs = Number.isFinite(parsedCopilotTimeoutMs)
    ? Math.max(60_000, parsedCopilotTimeoutMs)
    : 20 * 60 * 1000;

  const parsedMaxCodexWorkers = parseInt(
    process.env["YETI_MAX_CODEX_WORKERS"] ?? String(file.maxCodexWorkers ?? 1),
    10,
  );
  const maxCodexWorkers =
    Number.isFinite(parsedMaxCodexWorkers) && parsedMaxCodexWorkers >= 0
      ? parsedMaxCodexWorkers
      : 1;

  const parsedCodexTimeoutMs = parseInt(
    process.env["YETI_CODEX_TIMEOUT_MS"] ?? String(file.codexTimeoutMs ?? 20 * 60 * 1000),
    10,
  );
  const codexTimeoutMs = Number.isFinite(parsedCodexTimeoutMs)
    ? Math.max(60_000, parsedCodexTimeoutMs)
    : 20 * 60 * 1000;

  const envLogLevel = process.env["YETI_LOG_LEVEL"];
  const rawLogLevel = envLogLevel && (LOG_LEVELS as readonly string[]).includes(envLogLevel)
    ? envLogLevel as LogLevel
    : (LOG_LEVELS as readonly string[]).includes(file.logLevel as string)
      ? file.logLevel as LogLevel
      : "debug";
  const logLevel: LogLevel = rawLogLevel;

  const logRetentionDays = file.logRetentionDays ?? 14;
  const logRetentionPerJob = file.logRetentionPerJob ?? 20;
  const pausedJobs = file.pausedJobs ?? [];
  const skippedItems = file.skippedItems ?? [];
  const prioritizedItems = file.prioritizedItems ?? [];
  const allowedRepos = process.env["YETI_ALLOWED_REPOS"] !== undefined
    ? process.env["YETI_ALLOWED_REPOS"].split(",").map((s) => s.trim()).filter(Boolean)
    : file.allowedRepos ?? null;
  const includeForks = process.env["YETI_INCLUDE_FORKS"] === "true"
    || (process.env["YETI_INCLUDE_FORKS"] === undefined && (file.includeForks ?? false));
  const enabledJobs = file.enabledJobs ?? [];
  const reviewLoop = file.reviewLoop ?? false;
  const parsedMaxPlanRounds = file.maxPlanRounds ?? 3;
  const maxPlanRounds = Number.isFinite(parsedMaxPlanRounds) && parsedMaxPlanRounds >= 1
    ? Math.floor(parsedMaxPlanRounds)
    : 3;
  const parsedLearningsThreshold = file.learningsPendingThreshold ?? 5;
  const learningsPendingThreshold = Number.isFinite(parsedLearningsThreshold) && parsedLearningsThreshold >= 1
    ? Math.floor(parsedLearningsThreshold)
    : 5;
  const jobAi = file.jobAi ?? {};
  const queueScanIntervalMs = file.queueScanIntervalMs ?? 5 * 60 * 1000;

  const defaultAutonomy = coerceAutonomy(file.defaultAutonomy ?? "pr", "defaultAutonomy");
  const autonomy: Record<string, Autonomy> = {};
  for (const [repo, tier] of Object.entries(file.autonomy ?? {})) {
    autonomy[repo] = coerceAutonomy(tier, `autonomy["${repo}"]`);
  }

  const githubAppId = process.env["YETI_GITHUB_APP_ID"] ?? file.githubAppId ?? "";
  const githubAppInstallationId = process.env["YETI_GITHUB_APP_INSTALLATION_ID"] ?? file.githubAppInstallationId ?? "";
  const githubAppPrivateKeyPath = process.env["YETI_GITHUB_APP_PRIVATE_KEY_PATH"] ?? file.githubAppPrivateKeyPath ?? "";

  const githubAppClientId = process.env["YETI_GITHUB_APP_CLIENT_ID"] ?? file.githubAppClientId ?? "";
  const githubAppClientSecret = process.env["YETI_GITHUB_APP_CLIENT_SECRET"] ?? file.githubAppClientSecret ?? "";
  let externalUrl = (process.env["YETI_EXTERNAL_URL"] ?? file.externalUrl ?? "").replace(/\/+$/, "");
  if (externalUrl && !externalUrl.startsWith("http://") && !externalUrl.startsWith("https://")) {
    if (githubAppClientId && githubAppClientSecret) {
      console.warn(`[WARN] externalUrl "${externalUrl}" does not start with http:// or https:// — OAuth will be disabled`);
    }
    externalUrl = "";
  }

  const webhookSecret = process.env["YETI_WEBHOOK_SECRET"] ?? file.webhookSecret ?? "";

  return { githubOwners, selfRepo, port, intervals, schedules, logLevel, logRetentionDays, logRetentionPerJob, discordBotToken, discordChannelId, discordAllowedUsers, authToken, maxClaudeWorkers, claudeTimeoutMs, maxCopilotWorkers, copilotTimeoutMs, maxCodexWorkers, codexTimeoutMs, pausedJobs, skippedItems, prioritizedItems, allowedRepos, includeForks, enabledJobs, reviewLoop, maxPlanRounds, learningsPendingThreshold, jobAi, queueScanIntervalMs, githubAppId, githubAppInstallationId, githubAppPrivateKeyPath, githubAppClientId, githubAppClientSecret, externalUrl, webhookSecret, defaultAutonomy, autonomy };
}

const config = loadConfig();

export let GITHUB_OWNERS: readonly string[] = config.githubOwners;
export let SELF_REPO = config.selfRepo;
export const SERVER_PORT = config.port; // immutable — requires restart
export let INTERVALS = config.intervals;
export let SCHEDULES = config.schedules;
export let LOG_LEVEL: LogLevel = config.logLevel;
export let LOG_RETENTION_DAYS = config.logRetentionDays;
export let LOG_RETENTION_PER_JOB = config.logRetentionPerJob;
export let AUTH_TOKEN = config.authToken;
export let MAX_CLAUDE_WORKERS = config.maxClaudeWorkers;
export let CLAUDE_TIMEOUT_MS = config.claudeTimeoutMs;
export let PAUSED_JOBS: readonly string[] = config.pausedJobs;
export let SKIPPED_ITEMS: ReadonlyArray<{ repo: string; number: number }> = config.skippedItems;
export let PRIORITIZED_ITEMS: ReadonlyArray<{ repo: string; number: number }> = config.prioritizedItems;
export let ALLOWED_REPOS: readonly string[] | null = config.allowedRepos;
export let INCLUDE_FORKS = config.includeForks;
export let ENABLED_JOBS: readonly string[] = config.enabledJobs;
export let REVIEW_LOOP = config.reviewLoop;
export let MAX_PLAN_ROUNDS = config.maxPlanRounds;
export let LEARNINGS_PENDING_THRESHOLD = config.learningsPendingThreshold;
export let MAX_COPILOT_WORKERS = config.maxCopilotWorkers;
export let COPILOT_TIMEOUT_MS = config.copilotTimeoutMs;
export let MAX_CODEX_WORKERS = config.maxCodexWorkers;
export let CODEX_TIMEOUT_MS = config.codexTimeoutMs;
export let JOB_AI: Readonly<Record<string, { backend?: "claude" | "copilot" | "codex"; model?: string }>> = config.jobAi;
export let DEFAULT_AUTONOMY: Autonomy = config.defaultAutonomy;
export let AUTONOMY_MAP: Readonly<Record<string, Autonomy>> = config.autonomy;
export let QUEUE_SCAN_INTERVAL_MS = config.queueScanIntervalMs;
// Immutable — requires restart (bot connection)
export const DISCORD_BOT_TOKEN = config.discordBotToken;
export const DISCORD_CHANNEL_ID = config.discordChannelId;
// Immutable — requires restart (GitHub App auth)
export const GITHUB_APP_ID = config.githubAppId;
export const GITHUB_APP_INSTALLATION_ID = config.githubAppInstallationId;
export const GITHUB_APP_PRIVATE_KEY_PATH = config.githubAppPrivateKeyPath;
// Immutable — requires restart (OAuth)
export const GITHUB_APP_CLIENT_ID = config.githubAppClientId;
export const GITHUB_APP_CLIENT_SECRET = config.githubAppClientSecret;
export const EXTERNAL_URL = config.externalUrl;
// Immutable — requires restart (webhooks)
export const WEBHOOK_SECRET = config.webhookSecret;
// Live-reloadable
export let DISCORD_ALLOWED_USERS: readonly string[] = config.discordAllowedUsers;

// ── Change notification system ──

type ConfigChangeListener = () => void;
const listeners: Set<ConfigChangeListener> = new Set();

export function onConfigChange(listener: ConfigChangeListener): void {
  listeners.add(listener);
}

export function offConfigChange(listener: ConfigChangeListener): void {
  listeners.delete(listener);
}

function notifyListeners(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Don't let a failing listener break config reload
    }
  }
}

// ── Reload & write ──

export function reloadConfig(): void {
  const fresh = loadConfig();
  GITHUB_OWNERS = fresh.githubOwners;
  SELF_REPO = fresh.selfRepo;
  INTERVALS = fresh.intervals;
  SCHEDULES = fresh.schedules;
  LOG_LEVEL = fresh.logLevel;
  LOG_RETENTION_DAYS = fresh.logRetentionDays;
  LOG_RETENTION_PER_JOB = fresh.logRetentionPerJob;
  AUTH_TOKEN = fresh.authToken;
  MAX_CLAUDE_WORKERS = fresh.maxClaudeWorkers;
  CLAUDE_TIMEOUT_MS = fresh.claudeTimeoutMs;
  PAUSED_JOBS = fresh.pausedJobs;
  SKIPPED_ITEMS = fresh.skippedItems;
  PRIORITIZED_ITEMS = fresh.prioritizedItems;
  ALLOWED_REPOS = fresh.allowedRepos;
  INCLUDE_FORKS = fresh.includeForks;
  ENABLED_JOBS = fresh.enabledJobs;
  REVIEW_LOOP = fresh.reviewLoop;
  MAX_PLAN_ROUNDS = fresh.maxPlanRounds;
  LEARNINGS_PENDING_THRESHOLD = fresh.learningsPendingThreshold;
  MAX_COPILOT_WORKERS = fresh.maxCopilotWorkers;
  COPILOT_TIMEOUT_MS = fresh.copilotTimeoutMs;
  MAX_CODEX_WORKERS = fresh.maxCodexWorkers;
  CODEX_TIMEOUT_MS = fresh.codexTimeoutMs;
  JOB_AI = fresh.jobAi;
  QUEUE_SCAN_INTERVAL_MS = fresh.queueScanIntervalMs;
  DEFAULT_AUTONOMY = fresh.defaultAutonomy;
  AUTONOMY_MAP = fresh.autonomy;
  DISCORD_ALLOWED_USERS = fresh.discordAllowedUsers;
  notifyListeners();
}

const SENSITIVE_KEYS = new Set(["authToken", "discordBotToken", "githubAppClientSecret", "webhookSecret"]);

function maskValue(value: string): string {
  if (!value) return "Not configured";
  if (value.length <= 4) return "****";
  return "****" + value.slice(-4);
}

export function getConfigForDisplay(): Record<string, unknown> {
  const raw = loadConfig();
  const display: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (SENSITIVE_KEYS.has(key)) {
      display[key] = maskValue(value as string);
    } else {
      display[key] = value;
    }
  }

  return display;
}

// Maps a config field to the env var that overrides it. When the env var is set,
// it wins over ~/.yeti/config.json, so the dashboard must show that field as locked.
export const ENV_OVERRIDE_MAP: Readonly<Record<string, string>> = {
  githubOwners: "YETI_GITHUB_OWNERS",
  selfRepo: "YETI_SELF_REPO",
  port: "PORT",
  discordBotToken: "YETI_DISCORD_BOT_TOKEN",
  discordChannelId: "YETI_DISCORD_CHANNEL_ID",
  discordAllowedUsers: "YETI_DISCORD_ALLOWED_USERS",
  authToken: "YETI_AUTH_TOKEN",
  maxClaudeWorkers: "YETI_MAX_CLAUDE_WORKERS",
  claudeTimeoutMs: "YETI_CLAUDE_TIMEOUT_MS",
  maxCopilotWorkers: "YETI_MAX_COPILOT_WORKERS",
  copilotTimeoutMs: "YETI_COPILOT_TIMEOUT_MS",
  maxCodexWorkers: "YETI_MAX_CODEX_WORKERS",
  codexTimeoutMs: "YETI_CODEX_TIMEOUT_MS",
  logLevel: "YETI_LOG_LEVEL",
  allowedRepos: "YETI_ALLOWED_REPOS",
  includeForks: "YETI_INCLUDE_FORKS",
  githubAppId: "YETI_GITHUB_APP_ID",
  githubAppInstallationId: "YETI_GITHUB_APP_INSTALLATION_ID",
  githubAppPrivateKeyPath: "YETI_GITHUB_APP_PRIVATE_KEY_PATH",
  githubAppClientId: "YETI_GITHUB_APP_CLIENT_ID",
  githubAppClientSecret: "YETI_GITHUB_APP_CLIENT_SECRET",
  externalUrl: "YETI_EXTERNAL_URL",
  webhookSecret: "YETI_WEBHOOK_SECRET",
};

/** Returns { configField: ENV_VAR } for env vars currently set (i.e. locking that field). */
export function getEnvOverrides(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, envVar] of Object.entries(ENV_OVERRIDE_MAP)) {
    if (process.env[envVar] !== undefined) out[field] = envVar;
  }
  return out;
}

export function writeConfig(updates: Partial<ConfigFile>): void {
  let existing: ConfigFile = {};
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    existing = JSON.parse(raw) as ConfigFile;
  } catch {
    // Start from empty if missing or invalid
  }

  // Deep-merge, skipping empty secret fields to avoid clearing masked values
  for (const [key, value] of Object.entries(updates)) {
    if (SENSITIVE_KEYS.has(key) && value === "") continue;

    if (key === "intervals" && typeof value === "object" && value !== null) {
      existing.intervals = { ...existing.intervals, ...(value as ConfigFile["intervals"]) };
    } else if (key === "schedules" && typeof value === "object" && value !== null) {
      existing.schedules = { ...existing.schedules, ...(value as ConfigFile["schedules"]) };
    } else if (key === "jobAi" && typeof value === "object" && value !== null) {
      existing.jobAi = { ...existing.jobAi, ...(value as ConfigFile["jobAi"]) };
    } else {
      (existing as Record<string, unknown>)[key] = value;
    }
  }

  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(existing, null, 2) + "\n");
  reloadConfig();
}
