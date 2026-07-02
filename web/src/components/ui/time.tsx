import { useNow } from "../../lib/time";
import { formatRelativeTime, formatCountdown, formatClock } from "../../lib/format";

export function RelativeTime({ iso, className }: { iso: string | null; className?: string }) {
  const now = useNow();
  if (!iso) return <span className={className}>—</span>;
  return <span className={className} title={formatClock(iso)}>{formatRelativeTime(iso, now)}</span>;
}

/** Counts down to `startedAt + intervalMs` (relative to `nextRunIn` captured at fetch). */
export function CountdownTimer({ nextRunIn, capturedAt, className }: { nextRunIn: number | null; capturedAt: number; className?: string }) {
  const now = useNow();
  if (nextRunIn === null) return <span className={className}>—</span>;
  const remaining = nextRunIn - (now - capturedAt);
  return <span className={className}>{formatCountdown(remaining)}</span>;
}
