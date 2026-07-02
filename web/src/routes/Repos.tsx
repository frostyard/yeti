import { useState } from "react";
import { Link } from "react-router-dom";
import { Plus, FolderGit2 } from "lucide-react";
import { useRepos, useAddRepo } from "../lib/queries";
import { Card, SectionHeader, EmptyState, Skeleton, Button } from "../components/ui/base";
import { Badge } from "../components/ui/status";
import { Dialog } from "../components/ui/Dialog";
import { SelectInput } from "../components/ui/FormField";
import { RelativeTime } from "../components/ui/time";
import { categoryMeta } from "../lib/categories";
import { repoShortName, issueLogsPath } from "../lib/format";
import type { QueueItem } from "../lib/types";

function AddRepoDialog({ available }: { available: string[] }) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState("");
  const add = useAddRepo();
  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="Add repository"
      trigger={<Button variant="primary" size="md"><Plus size={14} /> Add repo</Button>}
    >
      {available.length === 0 ? (
        <p className="text-[13px] text-muted">All organization repos are already configured.</p>
      ) : (
        <div className="space-y-3">
          <SelectInput value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">Select a repository…</option>
            {available.map((r) => <option key={r} value={r}>{r}</option>)}
          </SelectInput>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!choice || add.isPending}
              loading={add.isPending}
              onClick={() => add.mutate(choice, { onSuccess: () => setOpen(false) })}
            >
              Add
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function Repos() {
  const { data, isLoading } = useRepos();
  if (isLoading || !data) return <Skeleton className="h-64" />;

  const byRepo = new Map<string, QueueItem[]>();
  for (const it of data.queueItems) {
    const list = byRepo.get(it.repo) ?? [];
    list.push(it);
    byRepo.set(it.repo, list);
  }

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-[20px] font-semibold text-text">Repositories</h1>
          <p className="text-[13px] text-muted">{data.repos.length} configured{data.allowedReposIsNull ? " · all org repos" : ""}</p>
        </div>
        <AddRepoDialog available={data.availableRepos.map((r) => r.name)} />
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {data.repos.map((repo) => {
          const items = byRepo.get(repo.fullName) ?? byRepo.get(repo.name) ?? [];
          return (
            <Card key={repo.fullName} className="p-4">
              <div className="mb-2 flex items-center gap-2">
                <FolderGit2 size={16} className="text-accent" />
                <span className="font-medium text-text">{repo.name}</span>
                <span className="ml-auto text-[12px] text-muted">{items.length} active</span>
              </div>
              {items.length === 0 ? (
                <p className="text-[12px] text-muted">No active items.</p>
              ) : (
                <ul className="space-y-1">
                  {items.slice(0, 6).map((it) => {
                    const meta = categoryMeta(it.category);
                    return (
                      <li key={`${it.repo}#${it.number}`} className="flex items-center gap-2 text-[12px]">
                        <Link to={issueLogsPath(it.repo, it.number)} className="font-mono text-secondary hover:text-accent">#{it.number}</Link>
                        <span className="truncate text-text/90">{it.title}</span>
                        <Badge color={meta.color} className="ml-auto shrink-0">{meta.label}</Badge>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Card>
          );
        })}
      </div>

      <section>
        <SectionHeader label="Recently Completed" />
        <Card className="p-2">
          {data.recentTasks.length === 0 ? <EmptyState title="No recent tasks" /> : (
            <ul className="divide-y divide-border/60">
              {data.recentTasks.slice(0, 20).map((t, i) => (
                <li key={`${t.run_id}-${i}`} className="flex items-center justify-between gap-2 px-2 py-2 text-[13px]">
                  <div className="min-w-0">
                    <span className="text-secondary">{t.job_name}</span>
                    <Link to={issueLogsPath(t.repo, t.item_number)} className="ml-2 font-mono text-[12px] text-muted hover:text-accent">
                      {repoShortName(t.repo)}#{t.item_number}
                    </Link>
                  </div>
                  <RelativeTime iso={t.completed_at ?? t.started_at} className="shrink-0 text-[12px] text-muted" />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>
    </div>
  );
}
