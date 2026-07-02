import { Link } from "react-router-dom";
import { Activity, ListChecks, CheckCircle2, XCircle, Cpu } from "lucide-react";
import { useOverview, useRuns } from "../lib/queries";
import { StatCard, StatusPill } from "../components/ui/status";
import { Card, SectionHeader, EmptyState, Skeleton } from "../components/ui/base";
import { RelativeTime } from "../components/ui/time";
import { DataTable, type Column } from "../components/ui/DataTable";
import { discordTone } from "../lib/discord";
import { repoShortName, issueLogsPath } from "../lib/format";
import type { JobRunRow, RunningTask } from "../lib/types";

export function Overview() {
  const { data, isLoading } = useOverview();
  const { data: runsData } = useRuns({});

  if (isLoading || !data) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
      </div>
    );
  }

  const d = data;
  const runCols: Column<JobRunRow>[] = [
    { key: "job", header: "Job", cell: (r) => <span className="font-medium text-text">{r.job_name}</span> },
    { key: "status", header: "Status", cell: (r) => <StatusPill kind={r.status} /> },
    { key: "started", header: "Started", cell: (r) => <RelativeTime iso={r.started_at} className="text-muted" /> },
  ];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[20px] font-semibold text-text">Overview</h1>
        <p className="text-[13px] text-muted">yeti automation daemon · uptime {fmtUptime(d.uptime)}</p>
      </header>

      <section>
        <SectionHeader label="Factory Pulse" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="Running" value={d.counts.running} tone="accent" icon={<Activity size={15} />} />
          <StatCard label="In Queue" value={d.counts.queuePending} tone="ice" icon={<ListChecks size={15} />} />
          <StatCard label="Recent Done" value={d.counts.recentDone} tone="success" icon={<CheckCircle2 size={15} />} />
          <StatCard label="Recent Failed" value={d.counts.recentFailed} tone={d.counts.recentFailed > 0 ? "danger" : "muted"} icon={<XCircle size={15} />} />
        </div>
      </section>

      <section>
        <SectionHeader label="AI Backends" />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <StatCard label="Claude" value={d.claudeQueue.active} tone="accent" sub={`${d.claudeQueue.pending} queued`} icon={<Cpu size={15} />} />
          <StatCard label="Copilot" value={d.copilotQueue.active} tone="ice" sub={`${d.copilotQueue.pending} queued`} icon={<Cpu size={15} />} />
          <StatCard label="Codex" value={d.codexQueue.active} tone="ice" sub={`${d.codexQueue.pending} queued`} icon={<Cpu size={15} />} />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section>
          <SectionHeader label="Running Now" action={<Link to="/jobs" className="text-muted hover:text-accent">jobs →</Link>} />
          <Card className="p-2">
            {d.runningTasks.length === 0 ? (
              <EmptyState title="Nothing running" hint="Jobs will appear here while active." />
            ) : (
              <ul className="divide-y divide-border/60">
                {d.runningTasks.map((t: RunningTask) => (
                  <li key={`${t.jobName}-${t.repo}-${t.itemNumber}`} className="flex items-center justify-between gap-2 px-2 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-medium text-text">{t.jobName}</div>
                      <Link to={issueLogsPath(t.repo, t.itemNumber)} className="text-[12px] text-muted hover:text-accent">
                        {repoShortName(t.repo)}#{t.itemNumber}
                      </Link>
                    </div>
                    <RelativeTime iso={t.startedAt} className="shrink-0 text-[12px] text-muted" />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>

        <section>
          <SectionHeader label="Recent Runs" action={<Link to="/logs" className="text-muted hover:text-accent">logs →</Link>} />
          <DataTable
            columns={runCols}
            rows={(runsData?.runs ?? []).slice(0, 8)}
            rowKey={(r) => r.run_id}
            empty={<EmptyState title="No runs yet" />}
          />
        </section>
      </div>

      <section>
        <SectionHeader label="Integrations" />
        <Card className="flex flex-wrap items-center gap-4 p-4 text-[13px]">
          <span className="section-label">Discord</span>
          <StatusPill kind={discordTone(d.discord).kind} label={discordTone(d.discord).text} />
        </Card>
      </section>
    </div>
  );
}

function fmtUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(" ");
}
