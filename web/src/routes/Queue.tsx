import { useState } from "react";
import { GitMerge, Star, StarOff, EyeOff, RotateCcw, ChevronDown } from "lucide-react";
import { useQueue, useQueueActions } from "../lib/queries";
import { QueueItemCard } from "../components/domain/QueueItemCard";
import { Card, SectionHeader, EmptyState, Skeleton, Button } from "../components/ui/base";
import { cn } from "../lib/cn";
import type { QueueItem } from "../lib/types";

export function Queue() {
  const { data, isLoading } = useQueue();
  const { merge, action } = useQueueActions();
  const [showSkipped, setShowSkipped] = useState(false);

  if (isLoading || !data) return <div className="space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}</div>;

  const busy = merge.isPending || action.isPending;

  const yetiActions = (item: QueueItem) => (
    <>
      {item.type === "pr" && item.checkStatus === "passing" && item.prNumber && (
        <Button size="sm" variant="success" disabled={busy} onClick={() => merge.mutate({ repo: item.repo, prNumber: item.prNumber! })} title="Squash & merge">
          <GitMerge size={13} /> Merge
        </Button>
      )}
      <Button size="sm" variant="ghost" disabled={busy}
        onClick={() => action.mutate({ action: item.prioritized ? "deprioritize" : "prioritize", repo: item.repo, number: item.number })}
        title={item.prioritized ? "Deprioritize" : "Prioritize"}>
        {item.prioritized ? <StarOff size={13} /> : <Star size={13} />}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => action.mutate({ action: "skip", repo: item.repo, number: item.number })} title="Skip">
        <EyeOff size={13} />
      </Button>
    </>
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[20px] font-semibold text-text">Queue</h1>
        <p className="text-[13px] text-muted">{data.myAttention.length + data.yetiAttention.length} items awaiting attention</p>
      </header>

      <section>
        <SectionHeader label="Needs My Attention" />
        <Card>
          {data.myAttention.length === 0 ? <EmptyState title="Nothing waiting on you" /> :
            data.myAttention.map((it) => <QueueItemCard key={`${it.repo}#${it.number}`} item={it} />)}
        </Card>
      </section>

      <section>
        <SectionHeader label="Needs Yeti Attention" />
        <Card>
          {data.yetiAttention.length === 0 ? <EmptyState title="Yeti's queue is clear" /> :
            data.yetiAttention.map((it) => <QueueItemCard key={`${it.repo}#${it.number}`} item={it} actions={yetiActions(it)} />)}
        </Card>
      </section>

      {data.skipped.length > 0 && (
        <section>
          <button className="mb-2 flex items-center gap-1.5 section-label hover:text-text" onClick={() => setShowSkipped((s) => !s)}>
            <ChevronDown size={14} className={cn("transition-transform", showSkipped && "rotate-180")} />
            Skipped ({data.skipped.length})
          </button>
          {showSkipped && (
            <Card className="p-2">
              <ul className="divide-y divide-border/60">
                {data.skipped.map((s) => (
                  <li key={`${s.repo}#${s.number}`} className="flex items-center justify-between px-2 py-2 text-[13px]">
                    <span className="font-mono text-secondary">{s.repo}#{s.number}</span>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => action.mutate({ action: "unskip", repo: s.repo, number: s.number })}>
                      <RotateCcw size={13} /> Restore
                    </Button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </section>
      )}
    </div>
  );
}
