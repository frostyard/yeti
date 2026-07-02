import { Play, Pause, PlayCircle } from "lucide-react";
import { useJobs, useJobActions } from "../lib/queries";
import { DataTable, type Column } from "../components/ui/DataTable";
import { StatusPill, type StatusKind } from "../components/ui/status";
import { Button, EmptyState, Skeleton } from "../components/ui/base";
import { RelativeTime, CountdownTimer } from "../components/ui/time";
import type { Job } from "../lib/types";

function jobStatus(j: Job): StatusKind {
  if (!j.enabled) return "disabled";
  if (j.running) return "running";
  if (j.paused) return "paused";
  return "idle";
}

function scheduleLabel(j: Job): string {
  if (j.schedule.scheduledHour !== undefined) return `daily @ ${String(j.schedule.scheduledHour).padStart(2, "0")}:00`;
  if (j.schedule.intervalMs) return `every ${Math.round(j.schedule.intervalMs / 60000)}m`;
  return "—";
}

export function Jobs() {
  const { data, isLoading, dataUpdatedAt } = useJobs();
  const { trigger, pause } = useJobActions();

  if (isLoading || !data) return <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>;

  const cols: Column<Job>[] = [
    {
      key: "name",
      header: "Job",
      cell: (j) => (
        <div className="min-w-0">
          <div className="font-medium text-text">{j.name}</div>
          <div className="truncate text-[12px] text-muted">{j.description}</div>
        </div>
      ),
    },
    { key: "status", header: "Status", cell: (j) => <StatusPill kind={jobStatus(j)} /> },
    { key: "schedule", header: "Schedule", cell: (j) => <span className="font-mono text-[12px] text-secondary">{scheduleLabel(j)}</span> },
    {
      key: "ai",
      header: "Backend",
      cell: (j) => <span className="text-[12px] text-secondary">{j.backend}{j.model ? <span className="text-muted"> · {j.model}</span> : null}</span>,
    },
    { key: "last", header: "Last run", cell: (j) => <RelativeTime iso={j.lastRun?.startedAt ?? null} className="text-muted" /> },
    { key: "next", header: "Next run", cell: (j) => <CountdownTimer nextRunIn={j.nextRunIn} capturedAt={dataUpdatedAt} className="font-mono text-[12px] text-secondary" /> },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (j) => (
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" disabled={!j.enabled || j.running || trigger.isPending} onClick={() => trigger.mutate(j.name)} title="Run now">
            <Play size={13} /> Run
          </Button>
          <Button size="sm" variant={j.paused ? "success" : "ghost"} disabled={!j.enabled || pause.isPending} onClick={() => pause.mutate(j.name)} title={j.paused ? "Resume" : "Pause"}>
            {j.paused ? <><PlayCircle size={13} /> Resume</> : <><Pause size={13} /> Pause</>}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[20px] font-semibold text-text">Jobs</h1>
        <p className="text-[13px] text-muted">{data.filter((j) => j.enabled).length} enabled · {data.length} total</p>
      </header>
      <DataTable columns={cols} rows={data} rowKey={(j) => j.name} empty={<EmptyState title="No jobs registered" />} />
    </div>
  );
}
