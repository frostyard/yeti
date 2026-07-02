import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

const inputCls =
  "h-8 w-full rounded-md border border-border bg-layer px-2.5 text-[13px] text-text placeholder:text-muted focus-visible:border-border-strong disabled:opacity-60";

export function Field({ label, hint, envVar, children }: { label: string; hint?: ReactNode; envVar?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-secondary">{label}</span>
      {children}
      {envVar ? <span className="text-[11px] text-warning">Set via env var {envVar} — edit there to change.</span> : null}
      {hint && !envVar ? <span className="text-[11px] text-muted">{hint}</span> : null}
    </label>
  );
}

export function TextInput({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(inputCls, className)} {...props} />;
}

export function SelectInput({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return <select className={cn(inputCls, className)} {...props}>{children}</select>;
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[13px] text-text">
      <input type="checkbox" className="accent-[var(--accent)]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
