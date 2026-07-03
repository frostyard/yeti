import type {
  Session, Overview, Job, QueueResponse, RunsResponse, RunDetail, TailResponse,
  IssueLogsResponse, NotificationRow, ReposResponse, ConfigResponse, LearningRow,
} from "./types";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(typeof body === "object" && body && "error" in body ? String((body as { error: unknown }).error) : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

/** Invoked whenever any request returns 401, so the app can route to /login. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  if (res.status === 401) { onUnauthorized?.(); throw new ApiError(401, body); }
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

function post<T>(path: string, data?: unknown): Promise<T> {
  return req<T>(path, { method: "POST", body: data === undefined ? undefined : JSON.stringify(data) });
}

export const api = {
  session: () => req<Session>("/api/session"),
  login: (token: string) => post<{ ok: boolean; username: string | null }>("/api/login", { token }),
  logout: () => post<{ ok: boolean }>("/api/logout"),

  overview: () => req<Overview>("/api/overview"),
  jobs: () => req<Job[]>("/api/jobs"),
  queue: () => req<QueueResponse>("/api/queue"),
  config: () => req<ConfigResponse>("/api/config"),
  repos: () => req<ReposResponse>("/api/repos"),
  notifications: (after?: number) =>
    req<NotificationRow[]>(`/api/notifications${after !== undefined ? `?after=${after}` : ""}`),
  learnings: (status?: string) =>
    req<LearningRow[]>(`/api/learnings${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  dismissLearning: (id: number, reason?: string) =>
    post<{ result: string }>(`/api/learnings/${id}/dismiss`, reason ? { reason } : undefined),

  runs: (params: { job?: string; search?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.job) qs.set("job", params.job);
    if (params.search) qs.set("search", params.search);
    if (params.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return req<RunsResponse>(`/api/runs${q ? `?${q}` : ""}`);
  },
  run: (runId: string) => req<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`),
  runTail: (runId: string, after: number) =>
    req<TailResponse>(`/api/runs/${encodeURIComponent(runId)}/tail?after=${after}`),
  issueLogs: (repo: string, number: number) =>
    req<IssueLogsResponse>(`/api/runs/issue?repo=${encodeURIComponent(repo)}&number=${number}`),

  triggerJob: (name: string) => post<{ result: string }>(`/api/jobs/${encodeURIComponent(name)}/trigger`),
  pauseJob: (name: string) => post<{ result: string }>(`/api/jobs/${encodeURIComponent(name)}/pause`),
  cancelTask: () => post<{ result: string }>("/api/tasks/cancel"),

  mergePR: (repo: string, prNumber: number) => post<{ result: string }>("/api/queue/merge", { repo, prNumber }),
  queueAction: (action: "skip" | "unskip" | "prioritize" | "deprioritize", repo: string, number: number) =>
    post<{ result: string }>(`/api/queue/${action}`, { repo, number }),
  addRepo: (repo: string) => post<{ result: string }>("/api/repos", { repo }),
  saveConfig: (updates: Record<string, unknown>) => post<{ saved: boolean; tab: string }>("/api/config", updates),
};
