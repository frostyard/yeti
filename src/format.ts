// Pure formatting helpers shared by the JSON API, the (legacy) HTML pages, and the
// frontend SPA (ported verbatim into web/src/lib/format.ts). No DOM or HTML dependencies.

export function repoShortName(fullName: string): string {
  const slash = fullName.indexOf("/");
  return slash >= 0 ? fullName.slice(slash + 1) : fullName;
}

export function itemLogsUrl(repo: string, itemNumber: number): string {
  return `/logs/issue?repo=${encodeURIComponent(repo)}&number=${itemNumber}`;
}

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

export function formatDuration(startedAt: string, completedAt: string | null): string {
  if (!completedAt) return "—";
  const ms = new Date(completedAt + "Z").getTime() - new Date(startedAt + "Z").getTime();
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

export function formatRelativeTime(isoDate: string): string {
  if (!isoDate) return "";
  const ms = Date.now() - Date.parse(isoDate);
  if (ms < 0) return "just now";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return "soon";
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hours = Math.floor(mins / 60);
  if (hours > 0) return `in ${hours}h ${mins % 60}m`;
  if (mins > 0) return `in ${mins}m`;
  return `in ${secs}s`;
}
