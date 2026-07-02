import { useNotifications } from "../lib/queries";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Badge } from "../components/ui/status";
import { EmptyState, Skeleton } from "../components/ui/base";
import { RelativeTime } from "../components/ui/time";
import type { NotificationRow } from "../lib/types";

const LEVEL_COLOR: Record<string, string> = { info: "#4aa8ff", warn: "#e0b34a", error: "#fb5a76" };

export function Notifications() {
  const { data, isLoading } = useNotifications();

  const cols: Column<NotificationRow>[] = [
    { key: "level", header: "Level", cell: (n) => <Badge color={LEVEL_COLOR[n.level]}>{n.level}</Badge> },
    { key: "job", header: "Job", cell: (n) => <span className="text-secondary">{n.jobName}</span> },
    {
      key: "message",
      header: "Message",
      cell: (n) => n.url
        ? <a href={n.url} target="_blank" rel="noreferrer" className="text-text hover:text-accent">{n.message}</a>
        : <span className="text-text">{n.message}</span>,
    },
    { key: "when", header: "When", align: "right", cell: (n) => <RelativeTime iso={n.createdAt} className="text-muted" /> },
  ];

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-[20px] font-semibold text-text">Notifications</h1>
        <p className="text-[13px] text-muted">Recent activity across all jobs</p>
      </header>
      {isLoading ? <Skeleton className="h-40" /> : (
        <DataTable columns={cols} rows={data ?? []} rowKey={(n) => String(n.id)} empty={<EmptyState title="No notifications yet" />} />
      )}
    </div>
  );
}
