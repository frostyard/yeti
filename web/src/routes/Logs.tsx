import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Search } from "lucide-react";
import { useRuns } from "../lib/queries";
import { DataTable, type Column } from "../components/ui/DataTable";
import { StatusPill } from "../components/ui/status";
import { EmptyState, Skeleton } from "../components/ui/base";
import { TextInput, SelectInput } from "../components/ui/FormField";
import { RelativeTime } from "../components/ui/time";
import { formatDuration } from "../lib/format";
import type { JobRunRow } from "../lib/types";

export function Logs() {
  const [params, setParams] = useSearchParams();
  const job = params.get("job") ?? "";
  const search = params.get("search") ?? "";
  const [searchInput, setSearchInput] = useState(search);
  const { data, isLoading } = useRuns({ job: job || undefined, search: search || undefined });

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next, { replace: true });
  };

  const cols: Column<JobRunRow>[] = [
    { key: "job", header: "Job", cell: (r) => <Link to={`/logs/${encodeURIComponent(r.run_id)}`} className="font-medium text-accent hover:underline">{r.job_name}</Link> },
    { key: "status", header: "Status", cell: (r) => <StatusPill kind={r.status} /> },
    { key: "started", header: "Started", cell: (r) => <RelativeTime iso={r.started_at} className="text-muted" /> },
    { key: "duration", header: "Duration", cell: (r) => <span className="font-mono text-[12px] text-secondary">{formatDuration(r.started_at, r.completed_at)}</span> },
  ];

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[20px] font-semibold text-text">Logs</h1>
        <p className="text-[13px] text-muted">Recent job runs</p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <form
          className="relative flex-1 min-w-[200px]"
          onSubmit={(e) => { e.preventDefault(); setParam("search", searchInput); }}
        >
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <TextInput className="pl-8" placeholder="Search repo#number…" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        </form>
        <SelectInput className="w-48" value={job} onChange={(e) => setParam("job", e.target.value)}>
          <option value="">All jobs</option>
          {(data?.jobNames ?? []).map((n) => <option key={n} value={n}>{n}</option>)}
        </SelectInput>
      </div>

      {isLoading ? <Skeleton className="h-40" /> : (
        <DataTable columns={cols} rows={data?.runs ?? []} rowKey={(r) => r.run_id} empty={<EmptyState title="No runs found" />} />
      )}
    </div>
  );
}
