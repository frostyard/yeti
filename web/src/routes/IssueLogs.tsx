import { useSearchParams, Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useIssueLogs } from "../lib/queries";
import { LogViewer } from "../components/domain/LogViewer";
import { StatusPill } from "../components/ui/status";
import { Card, SectionHeader, EmptyState, Skeleton } from "../components/ui/base";
import { RelativeTime } from "../components/ui/time";
import { repoShortName } from "../lib/format";

export function IssueLogs() {
  const [params] = useSearchParams();
  const repo = params.get("repo") ?? "";
  const number = parseInt(params.get("number") ?? "", 10) || 0;
  const { data, isLoading } = useIssueLogs(repo, number);

  if (!repo || !number) return <EmptyState title="Missing repo/number" />;
  if (isLoading) return <Skeleton className="h-64" />;

  const runs = data?.runs ?? [];

  return (
    <div className="space-y-4">
      <Link to="/logs" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-accent"><ArrowLeft size={14} /> Logs</Link>
      <header>
        <h1 className="text-[20px] font-semibold text-text">{repoShortName(repo)}<span className="text-muted">#{number}</span></h1>
        <p className="text-[13px] text-muted">{runs.length} run{runs.length === 1 ? "" : "s"} touched this item</p>
      </header>

      {runs.length === 0 ? <EmptyState title="No runs recorded for this item" /> : runs.map((run) => (
        <section key={run.run_id}>
          <SectionHeader
            label={run.job_name}
            action={<Link to={`/logs/${encodeURIComponent(run.run_id)}`} className="text-muted hover:text-accent">open run →</Link>}
          />
          <div className="mb-2 flex items-center gap-2">
            <StatusPill kind={run.status} />
            <RelativeTime iso={run.started_at} className="text-[12px] text-muted" />
          </div>
          {(data?.logsByRun[run.run_id]?.length ?? 0) === 0
            ? <Card className="px-3 py-4 text-[12px] text-muted">No log lines.</Card>
            : <LogViewer runId={run.run_id} initialLogs={data!.logsByRun[run.run_id]} initialStatus={run.status} live={false} />}
        </section>
      ))}
    </div>
  );
}
