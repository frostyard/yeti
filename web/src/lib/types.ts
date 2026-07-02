// Shapes returned by the yeti JSON API (/api/*).

export type AiBackend = "claude" | "copilot" | "codex";
export type QueueCategory =
  | "ready" | "needs-refinement" | "refined" | "needs-review-addressing"
  | "auto-mergeable" | "needs-triage" | "needs-plan-review";
export type NotificationLevel = "info" | "warn" | "error";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type RunStatus = "running" | "completed" | "failed";

export interface Session {
  authEnabled: boolean;
  authenticated: boolean;
  username: string | null;
  methods: { token: boolean; oauth: boolean };
  oauthLoginUrl: string;
}

export interface QueueDepth { pending: number; active: number; }

export interface RunningTask {
  jobName: string;
  repo: string;
  itemNumber: number;
  startedAt: string;
}

export interface JobSchedule {
  intervalMs?: number;
  scheduledHour?: number;
  lastCompletedAt: string | null;
  nextRunIn: number | null;
}

export interface DiscordStatus {
  configured: boolean;
  connected: boolean;
  lastResult: "ok" | "error" | null;
}

export interface Overview {
  status: string;
  version: string;
  startedAt: string;
  uptime: number;
  jobs: Record<string, boolean>;
  pausedJobs: string[];
  claudeQueue: QueueDepth;
  copilotQueue: QueueDepth;
  codexQueue: QueueDepth;
  runningTasks: RunningTask[];
  jobSchedules: Record<string, JobSchedule>;
  jobAi: Record<string, { backend?: AiBackend; model?: string }>;
  discord: DiscordStatus;
  counts: { running: number; queuePending: number; recentDone: number; recentFailed: number };
}

export interface JobRunSummary {
  runId: string;
  status: RunStatus;
  startedAt: string;
  completedAt: string | null;
}

export interface Job {
  name: string;
  description: string;
  enabled: boolean;
  running: boolean;
  paused: boolean;
  backend: AiBackend;
  model: string | null;
  schedule: { intervalMs?: number; scheduledHour?: number };
  lastRun: JobRunSummary | null;
  nextRunIn: number | null;
}

export interface QueueItem {
  repo: string;
  number: number;
  title: string;
  category: QueueCategory;
  updatedAt: string;
  type: "issue" | "pr";
  checkStatus?: "passing" | "failing" | "pending";
  prNumber?: number;
  prioritized?: boolean;
}

export interface QueueResponse {
  myAttention: QueueItem[];
  yetiAttention: QueueItem[];
  skipped: { repo: string; number: number }[];
  oldestFetchAt: number | null;
}

export interface JobRunRow {
  run_id: string;
  job_name: string;
  status: RunStatus;
  started_at: string;
  completed_at: string | null;
}

export interface TaskRow {
  id: number;
  job_name: string;
  repo: string;
  item_number: number;
  status: RunStatus;
  error: string | null;
  started_at: string;
  completed_at: string | null;
  run_id: string | null;
}

export interface RunsResponse {
  runs: JobRunRow[];
  jobNames: string[];
  workItems: Record<string, TaskRow[]>;
  recentItems: { repo: string; item_number: number }[];
}

export interface LogRow {
  id: number;
  level: LogLevel;
  message: string;
  logged_at: string;
}

export interface RunDetail {
  run: JobRunRow;
  logs: LogRow[];
  tasks: {
    id: number; job_name: string; repo: string; item_number: number;
    status: RunStatus; error: string | null; started_at: string; completed_at: string | null;
  }[];
}

export interface TailResponse {
  status: RunStatus;
  completed_at: string | null;
  logs: LogRow[];
}

export interface IssueLogsResponse {
  repo: string;
  number: number;
  runs: JobRunRow[];
  logsByRun: Record<string, LogRow[]>;
  workItems: Record<string, TaskRow[]>;
}

export interface NotificationRow {
  id: number;
  jobName: string;
  message: string;
  url: string | null;
  level: NotificationLevel;
  createdAt: string;
}

export interface Repo {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
}

export interface ReposResponse {
  repos: Repo[];
  queueItems: QueueItem[];
  recentTasks: {
    job_name: string; repo: string; item_number: number;
    status: RunStatus; started_at: string; completed_at: string | null; run_id: string | null;
  }[];
  availableRepos: Repo[];
  allowedReposIsNull: boolean;
}
