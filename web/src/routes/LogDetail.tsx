import { Link, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useRun } from "../lib/queries";
import { LogViewer } from "../components/domain/LogViewer";
import { StatusPill } from "../components/ui/status";
import { Skeleton, EmptyState } from "../components/ui/base";
import { RelativeTime } from "../components/ui/time";
import { formatDuration, repoShortName, issueLogsPath } from "../lib/format";

export function LogDetail() {
  const { runId = "" } = useParams();
  const { data, isLoading, isError } = useRun(runId);

  if (isLoading) return <Skeleton className="h-64" />;
  if (isError || !data) return <EmptyState title="Run not found" hint="It may have been pruned." />;

  const { run, logs, tasks } = data;
  return (
    <div className="space-y-4">
      <Link to="/logs" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-accent"><ArrowLeft size={14} /> Logs</Link>
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-[20px] font-semibold text-text">{run.job_name}</h1>
        <StatusPill kind={run.status} />
        <span className="text-[13px] text-muted">
          started <RelativeTime iso={run.started_at} /> · {formatDuration(run.started_at, run.completed_at)}
        </span>
      </header>

      {tasks.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {tasks.map((t) => (
            <Link key={t.id} to={issueLogsPath(t.repo, t.item_number)} className="rounded-full border border-border px-2.5 py-1 text-[12px] text-secondary hover:border-border-strong hover:text-text">
              {repoShortName(t.repo)}#{t.item_number} · {t.status}
            </Link>
          ))}
        </div>
      )}

      <LogViewer runId={run.run_id} initialLogs={logs} initialStatus={run.status} />
    </div>
  );
}
