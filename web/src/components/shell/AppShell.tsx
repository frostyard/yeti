import { NavLink, Outlet, useNavigate } from "react-router-dom";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Snowflake, Bell, Sun, Moon, Monitor, LogOut, Menu, RefreshCw } from "lucide-react";
import { useTheme, type Theme } from "../../theme/useTheme";
import { useOverview, useSession } from "../../lib/queries";
import { useRealtime } from "../../lib/realtime";
import { PulseDot } from "../ui/base";
import { RelativeTime } from "../ui/time";
import { cn } from "../../lib/cn";
import { api } from "../../lib/api";

const NAV = [
  { to: "/", label: "Overview", end: true },
  { to: "/queue", label: "Queue" },
  { to: "/jobs", label: "Jobs" },
  { to: "/logs", label: "Logs" },
  { to: "/repos", label: "Repos" },
  { to: "/notifications", label: "Notifications" },
  { to: "/learnings", label: "Learnings" },
  { to: "/config", label: "Config" },
];

const THEME_ICON: Record<Theme, typeof Sun> = { system: Monitor, light: Sun, dark: Moon };

function Brand() {
  return (
    <NavLink to="/" className="flex items-center gap-2 pr-2">
      <Snowflake size={20} className="text-ice" />
      <span className="text-[15px] font-semibold tracking-tight text-text">
        frostyard<span className="text-muted"> / </span><span className="text-accent">yeti</span>
      </span>
    </NavLink>
  );
}

function navClass({ isActive }: { isActive: boolean }) {
  return cn(
    "relative px-2.5 py-1.5 text-[13px] transition-colors",
    isActive ? "text-text" : "text-secondary hover:text-text",
    isActive && "after:absolute after:inset-x-2 after:-bottom-[11px] after:h-0.5 after:rounded-full after:bg-accent",
  );
}

function SystemStatus() {
  const { data } = useOverview();
  const healthy = !!data;
  return (
    <div className="hidden items-center gap-2 text-[12px] text-muted md:flex">
      <PulseDot color={healthy ? "var(--success)" : "var(--text-muted)"} pulse={healthy} size={8} />
      <span className="text-secondary">{healthy ? "healthy" : "connecting…"}</span>
      {data && <span className="font-mono text-muted">{data.version}</span>}
    </div>
  );
}

function ThemeToggle() {
  const { theme, cycle } = useTheme();
  const Icon = THEME_ICON[theme];
  return (
    <button onClick={cycle} aria-label={`Theme: ${theme}`} title={`Theme: ${theme}`} className="rounded-md border border-border p-1.5 text-secondary hover:border-border-strong hover:text-text">
      <Icon size={16} />
    </button>
  );
}

function NotificationBell() {
  const { notifications, unread, markAllRead } = useRealtime();
  return (
    <DropdownMenu.Root onOpenChange={(o) => o && markAllRead()}>
      <DropdownMenu.Trigger asChild>
        <button aria-label="Notifications" className="relative rounded-md border border-border p-1.5 text-secondary hover:border-border-strong hover:text-text">
          <Bell size={16} />
          {unread > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={8} className="z-50 max-h-[70vh] w-[min(92vw,360px)] overflow-y-auto rounded-[var(--radius-card)] border border-border bg-raised p-1 shadow-[var(--shadow-pop)]">
          {notifications.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-muted">No notifications</div>
          ) : (
            notifications.slice(0, 30).map((n) => (
              <a
                key={n.id}
                href={n.url ?? undefined}
                target={n.url ? "_blank" : undefined}
                rel="noreferrer"
                className="block rounded-md px-3 py-2 hover:bg-layer/60"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="section-label truncate">{n.jobName}</span>
                  <RelativeTime iso={n.createdAt} className="shrink-0 text-[11px] text-muted" />
                </div>
                <div className={cn("mt-0.5 text-[12px]", n.level === "error" ? "text-danger" : n.level === "warn" ? "text-warning" : "text-secondary")}>
                  {n.message}
                </div>
              </a>
            ))
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function UserMenu() {
  const { data: session } = useSession();
  const navigate = useNavigate();
  if (!session?.authEnabled) return null;
  const logout = async () => { await api.logout().catch(() => {}); navigate("/login"); };
  return (
    <button onClick={logout} title="Log out" aria-label="Log out" className="rounded-md border border-border p-1.5 text-secondary hover:border-border-strong hover:text-text">
      <LogOut size={16} />
    </button>
  );
}

function MobileNav() {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button aria-label="Menu" className="rounded-md border border-border p-1.5 text-secondary hover:text-text lg:hidden">
          <Menu size={16} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={8} className="z-50 w-48 rounded-[var(--radius-card)] border border-border bg-raised p-1 shadow-[var(--shadow-pop)]">
          {NAV.map((n) => (
            <DropdownMenu.Item key={n.to} asChild>
              <NavLink to={n.to} end={n.end} className="block rounded-md px-3 py-2 text-[13px] text-secondary hover:bg-layer/60 hover:text-text">
                {n.label}
              </NavLink>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function UpdateBanner() {
  const { data } = useOverview();
  if (!data?.updatePending) return null;
  return (
    <div className="border-b border-warning/30 bg-warning/10" role="status" aria-live="polite">
      <div className="mx-auto flex max-w-[1400px] items-center gap-2 px-4 py-2 text-[13px] text-warning">
        <RefreshCw size={14} className="animate-spin" />
        <span>
          Update pending{data.pendingUpdateTag ? ` (${data.pendingUpdateTag})` : ""} — draining running jobs before deploy. New jobs are paused.
        </span>
      </div>
    </div>
  );
}

export function AppShell() {
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 border-b border-border bg-bg/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-3 px-4">
          <Brand />
          <nav className="hidden items-center lg:flex" aria-label="Primary">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={navClass} aria-current="page">
                {n.label}
              </NavLink>
            ))}
          </nav>
          <MobileNav />
          <div className="ml-auto flex items-center gap-2">
            <SystemStatus />
            <NotificationBell />
            <ThemeToggle />
            <UserMenu />
          </div>
        </div>
      </header>
      <UpdateBanner />
      <main className="mx-auto max-w-[1400px] px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
