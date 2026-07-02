import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { PulseDot } from "./base";

// ── StatusPill ──
export type StatusKind = "running" | "idle" | "paused" | "disabled" | "completed" | "failed" | "pending" | "passing" | "failing" | "untested";

const pill = cva("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold", {
  variants: {
    kind: {
      running: "bg-success/12 text-success",
      passing: "bg-success/12 text-success",
      completed: "bg-success/12 text-success",
      idle: "bg-border/50 text-muted",
      pending: "bg-border/50 text-secondary",
      disabled: "bg-border/40 text-muted",
      untested: "bg-warning/12 text-warning",
      paused: "bg-warning/12 text-warning",
      failing: "bg-danger/12 text-danger",
      failed: "bg-danger/12 text-danger",
    },
  },
  defaultVariants: { kind: "idle" },
});

const DOT: Partial<Record<StatusKind, string>> = {
  running: "var(--success)",
  completed: "var(--success)",
  passing: "var(--success)",
  paused: "var(--warning)",
  untested: "var(--warning)",
  failed: "var(--danger)",
  failing: "var(--danger)",
  idle: "var(--text-muted)",
  pending: "var(--text-muted)",
  disabled: "var(--text-muted)",
};

export function StatusPill({ kind, label, className }: VariantProps<typeof pill> & { kind: StatusKind; label?: string; className?: string }) {
  const text = label ?? kind[0].toUpperCase() + kind.slice(1);
  return (
    <span className={cn(pill({ kind }), className)} aria-label={text}>
      <PulseDot color={DOT[kind] ?? "var(--text-muted)"} pulse={kind === "running"} size={7} />
      {text}
    </span>
  );
}

// ── Badge (labeled chip, colored by category or tone) ──
export function Badge({ color, children, className }: { color?: string; children: ReactNode; className?: string }) {
  const style = color
    ? { color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)`, background: `color-mix(in srgb, ${color} 14%, transparent)` }
    : undefined;
  return (
    <span
      className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium", !color && "border-border text-secondary", className)}
      style={style}
    >
      {children}
    </span>
  );
}

// ── StatCard / Metric ──
type Tone = "accent" | "ice" | "success" | "warning" | "danger" | "muted";
const TONE: Record<Tone, string> = {
  accent: "text-accent",
  ice: "text-ice",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  muted: "text-secondary",
};

export function StatCard({ label, value, tone = "muted", sub, icon }: { label: string; value: ReactNode; tone?: Tone; sub?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface px-4 py-3 shadow-[var(--shadow-card)]">
      <div className="flex items-center justify-between">
        <span className="section-label">{label}</span>
        {icon ? <span className="text-muted">{icon}</span> : null}
      </div>
      <div className={cn("mt-1 font-mono text-[28px] font-semibold leading-none tabular-nums", TONE[tone])}>{value}</div>
      {sub ? <div className="mt-1 text-[12px] text-muted">{sub}</div> : null}
    </div>
  );
}
