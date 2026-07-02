// Ported verbatim from the daemon's src/format.ts so the SPA and API agree on
// how uptime / relative time / countdowns render.

export function repoShortName(fullName: string): string {
  const slash = fullName.indexOf("/");
  return slash >= 0 ? fullName.slice(slash + 1) : fullName;
}

export function issueLogsPath(repo: string, itemNumber: number): string {
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

/** SQLite timestamps are stored UTC without a zone; append Z when parsing. */
function parseSqlDate(iso: string): number {
  if (!iso) return NaN;
  return iso.includes("T") || iso.endsWith("Z") ? Date.parse(iso) : Date.parse(iso + "Z");
}

export function formatDuration(startedAt: string, completedAt: string | null): string {
  if (!completedAt) return "—";
  const ms = parseSqlDate(completedAt) - parseSqlDate(startedAt);
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

export function formatRelativeTime(isoDate: string, now: number = Date.now()): string {
  if (!isoDate) return "";
  const ms = now - parseSqlDate(isoDate);
  if (!Number.isFinite(ms)) return "";
  if (ms < 0) return "just now";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
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

export function formatClock(isoDate: string): string {
  const t = parseSqlDate(isoDate);
  if (!Number.isFinite(t)) return "";
  return new Date(t).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}
