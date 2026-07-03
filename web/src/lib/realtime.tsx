import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import type { NotificationRow } from "./types";
import { api } from "./api";
import { cn } from "./cn";

interface RealtimeCtx {
  notifications: NotificationRow[];
  unread: number;
  markAllRead: () => void;
}

const Ctx = createContext<RealtimeCtx>({ notifications: [], unread: 0, markAllRead: () => {} });
export const useRealtime = () => useContext(Ctx);

interface Toast extends NotificationRow { key: string; }

const toneBorder: Record<string, string> = {
  info: "border-l-accent",
  warn: "border-l-warning",
  error: "border-l-danger",
};

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [unread, setUnread] = useState(0);
  const seq = useRef(0);

  const dismiss = useCallback((key: string) => {
    setToasts((t) => t.filter((x) => x.key !== key));
  }, []);

  const pushToast = useCallback((n: NotificationRow) => {
    const key = `${n.id}-${seq.current++}`;
    setToasts((t) => [...t, { ...n, key }]);
    setTimeout(() => dismiss(key), 8000);
  }, [dismiss]);

  useEffect(() => {
    let cancelled = false;
    // Seed the bell with recent history.
    api.notifications().then((rows) => { if (!cancelled) setNotifications(rows); }).catch(() => {});

    const es = new EventSource("/api/notifications/stream", { withCredentials: true });
    es.onmessage = (e) => {
      try {
        const n = JSON.parse(e.data) as NotificationRow;
        setNotifications((prev) => (prev.some((p) => p.id === n.id) ? prev : [n, ...prev].slice(0, 100)));
        setUnread((u) => u + 1);
        pushToast(n);
        qc.invalidateQueries({ queryKey: ["overview"] });
        qc.invalidateQueries({ queryKey: ["queue"] });
        qc.invalidateQueries({ queryKey: ["jobs"] });
      } catch { /* ignore malformed frame */ }
    };
    return () => { cancelled = true; es.close(); };
  }, [qc, pushToast]);

  const markAllRead = useCallback(() => setUnread(0), []);

  return (
    <Ctx.Provider value={{ notifications, unread, markAllRead }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(92vw,360px)] flex-col gap-2" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <div
            key={t.key}
            role="status"
            onClick={() => { if (t.url) window.open(t.url, "_blank"); dismiss(t.key); }}
            className={cn(
              "pointer-events-auto cursor-pointer rounded-[10px] border border-border border-l-4 bg-raised p-3 shadow-[var(--shadow-pop)] transition",
              toneBorder[t.level] ?? "border-l-accent",
            )}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="section-label truncate">{t.jobName}</div>
                <div className="mt-0.5 text-[13px] text-text">{t.message}</div>
              </div>
              <button
                aria-label="Dismiss"
                onClick={(e) => { e.stopPropagation(); dismiss(t.key); }}
                className="shrink-0 rounded p-0.5 text-muted hover:text-text"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
