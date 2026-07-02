import { useLearnings, useDismissLearning } from "../lib/queries";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Badge } from "../components/ui/status";
import { EmptyState, Skeleton } from "../components/ui/base";
import { RelativeTime } from "../components/ui/time";
import type { LearningRow } from "../lib/types";

const STATUS_COLOR: Record<string, string> = { pending: "#4aa8ff", consolidated: "#4ade80", dismissed: "#8b95a7" };

export function Learnings() {
  const { data, isLoading } = useLearnings();
  const dismiss = useDismissLearning();

  const cols: Column<LearningRow>[] = [
    { key: "status", header: "Status", cell: (l) => <Badge color={STATUS_COLOR[l.status]}>{l.status}</Badge> },
    { key: "job", header: "Job", cell: (l) => <span className="text-secondary">{l.jobName}</span> },
    { key: "repo", header: "Repo", cell: (l) => <span className="text-secondary">{l.repo}</span> },
    {
      key: "summary",
      header: "Learning",
      cell: (l) => (
        <span className="text-text">
          {l.summary}
          {l.status === "consolidated" && l.prNumber ? <span className="text-muted"> · PR #{l.prNumber}</span> : null}
          {l.status === "dismissed" && l.reason ? <span className="text-muted"> · {l.reason}</span> : null}
        </span>
      ),
    },
    { key: "when", header: "When", cell: (l) => <RelativeTime iso={l.createdAt} className="text-muted" /> },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (l) => l.status === "pending" ? (
        <button
          className="rounded-md border border-border px-2 py-1 text-[12px] text-secondary hover:border-border-strong hover:text-text"
          onClick={() => dismiss.mutate({ id: l.id })}
          disabled={dismiss.isPending}
        >
          Dismiss
        </button>
      ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[20px] font-semibold text-text">Learnings</h1>
        <p className="text-[13px] text-muted">Environment friction reported by agents — pending items are consolidated into policies by PR</p>
      </header>
      {isLoading ? <Skeleton className="h-40" /> : (
        <DataTable columns={cols} rows={data ?? []} rowKey={(l) => String(l.id)} empty={<EmptyState title="No learnings yet" />} />
      )}
    </div>
  );
}
