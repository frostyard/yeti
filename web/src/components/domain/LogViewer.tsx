import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { cn } from "../../lib/cn";
import type { LogRow, LogLevel, RunStatus } from "../../lib/types";

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
const LEVEL_CLASS: Record<LogLevel, string> = {
  debug: "text-log-debug",
  info: "text-log-info",
  warn: "text-log-warn",
  error: "text-log-error",
};

export function LogViewer({ runId, initialLogs, initialStatus, live = true }: {
  runId: string;
  initialLogs: LogRow[];
  initialStatus: RunStatus;
  live?: boolean;
}) {
  const [logs, setLogs] = useState<LogRow[]>(initialLogs);
  const [status, setStatus] = useState<RunStatus>(initialStatus);
  const [filter, setFilter] = useState<LogLevel | "all">("all");
  const boxRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useEffect(() => { setLogs(initialLogs); setStatus(initialStatus); }, [runId, initialLogs, initialStatus]);

  // Live tail while running.
  useEffect(() => {
    if (!live || status !== "running") return;
    let stop = false;
    const id = setInterval(async () => {
      const last = logs.length ? logs[logs.length - 1].id : 0;
      try {
        const res = await api.runTail(runId, last);
        if (stop) return;
        if (res.logs.length) setLogs((prev) => [...prev, ...res.logs]);
        if (res.status !== "running") setStatus(res.status);
      } catch { /* transient */ }
    }, 2000);
    return () => { stop = true; clearInterval(id); };
  }, [runId, status, live, logs]);

  // Auto-scroll if the user is already at the bottom.
  useEffect(() => {
    const box = boxRef.current;
    if (box && atBottom.current) box.scrollTop = box.scrollHeight;
  }, [logs]);

  const shown = filter === "all" ? logs : logs.filter((l) => l.level === filter);

  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <span className="section-label mr-1">Log level</span>
        {(["all", ...LEVELS] as const).map((lv) => (
          <button
            key={lv}
            onClick={() => setFilter(lv)}
            className={cn("rounded px-2 py-0.5 text-[11px] font-medium capitalize", filter === lv ? "bg-accent/15 text-accent" : "text-muted hover:text-text")}
          >
            {lv}
          </button>
        ))}
        {status === "running" && <span className="ml-auto text-[11px] text-success">● live</span>}
      </div>
      <div
        ref={boxRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="max-h-[60dvh] overflow-y-auto p-3 font-mono text-[12px] leading-relaxed"
      >
        {shown.length === 0 ? (
          <div className="py-8 text-center text-muted">No log lines{filter !== "all" ? ` at level ${filter}` : ""}.</div>
        ) : (
          shown.map((l) => (
            <div key={l.id} className="flex gap-3 whitespace-pre-wrap break-words">
              <span className="shrink-0 text-muted">{l.logged_at.slice(11, 19)}</span>
              <span className={cn("w-10 shrink-0 uppercase", LEVEL_CLASS[l.level])}>{l.level}</span>
              <span className="text-text/90">{l.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
