import { Link } from "react-router-dom";
import { Star, GitPullRequest, CircleDot, CheckCircle2, XCircle, Clock } from "lucide-react";
import type { QueueItem } from "../../lib/types";
import { Badge } from "../ui/status";
import { RelativeTime } from "../ui/time";
import { categoryMeta } from "../../lib/categories";
import { repoShortName, issueLogsPath } from "../../lib/format";
import type { ReactNode } from "react";

function CheckIcon({ status }: { status?: QueueItem["checkStatus"] }) {
  if (status === "passing") return <CheckCircle2 size={14} className="text-success" aria-label="checks passing" />;
  if (status === "failing") return <XCircle size={14} className="text-danger" aria-label="checks failing" />;
  if (status === "pending") return <Clock size={14} className="text-warning" aria-label="checks pending" />;
  return null;
}

export function QueueItemCard({ item, actions }: { item: QueueItem; actions?: ReactNode }) {
  const meta = categoryMeta(item.category);
  return (
    <div className="flex items-center gap-3 border-b border-border/60 px-3 py-2.5 last:border-0 hover:bg-layer/40">
      {item.prioritized ? <Star size={14} className="shrink-0 fill-warning text-warning" aria-label="prioritized" /> : <span className="w-[14px]" />}
      {item.type === "pr" ? <GitPullRequest size={14} className="shrink-0 text-muted" /> : <CircleDot size={14} className="shrink-0 text-muted" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Link to={issueLogsPath(item.repo, item.number)} className="shrink-0 font-mono text-[12px] text-secondary hover:text-accent">
            {repoShortName(item.repo)}#{item.number}
          </Link>
          <CheckIcon status={item.checkStatus} />
          <span className="truncate text-[13px] text-text">{item.title}</span>
        </div>
      </div>
      <Badge color={meta.color} className="shrink-0">{meta.label}</Badge>
      <RelativeTime iso={item.updatedAt} className="hidden shrink-0 text-[12px] text-muted sm:inline" />
      {actions ? <div className="flex shrink-0 gap-1.5">{actions}</div> : null}
    </div>
  );
}
