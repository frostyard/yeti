import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";

// ── Button ──
const button = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-md text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none",
  {
    variants: {
      variant: {
        primary: "bg-accent text-[#04121f] hover:bg-accent-bright",
        ghost: "border border-border bg-transparent text-secondary hover:border-border-strong hover:text-text",
        danger: "border border-danger/40 bg-transparent text-danger hover:bg-danger/10",
        success: "border border-success/40 bg-transparent text-success hover:bg-success/10",
      },
      size: {
        sm: "h-7 px-2.5",
        md: "h-8 px-3",
      },
    },
    defaultVariants: { variant: "ghost", size: "sm" },
  },
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof button> {
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading, disabled, children, ...props }, ref) => (
    <button ref={ref} className={cn(button({ variant, size }), className)} disabled={disabled || loading} {...props}>
      {loading ? <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" /> : children}
    </button>
  ),
);
Button.displayName = "Button";

// ── Card ──
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-card)]", className)}>
      {children}
    </div>
  );
}

// ── SectionHeader ──
export function SectionHeader({ label, action, className }: { label: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("mb-2 flex items-center justify-between gap-3", className)}>
      <h2 className="section-label">{label}</h2>
      {action ? <div className="text-[12px]">{action}</div> : null}
    </div>
  );
}

// ── PulseDot ──
export function PulseDot({ color = "var(--success)", pulse = true, size = 8 }: { color?: string; pulse?: boolean; size?: number }) {
  return (
    <span className="relative inline-flex" style={{ width: size, height: size }}>
      {pulse && (
        <span
          className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60"
          style={{ background: color }}
        />
      )}
      <span className="relative inline-flex rounded-full" style={{ width: size, height: size, background: color }} />
    </span>
  );
}

// ── EmptyState ──
export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[var(--radius-card)] border border-dashed border-border px-4 py-10 text-center">
      <div className="text-[13px] font-medium text-secondary">{title}</div>
      {hint ? <div className="mt-1 text-[12px] text-muted">{hint}</div> : null}
    </div>
  );
}

// ── Skeleton ──
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-border/60", className)} />;
}
