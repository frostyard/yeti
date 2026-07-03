import { usePolicies } from "../lib/queries";
import { DataTable, type Column } from "../components/ui/DataTable";
import { EmptyState, SectionHeader, Skeleton } from "../components/ui/base";
import { Badge } from "../components/ui/status";
import type { JobGate, PolicyInfo, RepoTierInfo } from "../lib/types";

const SOURCE_COLOR: Record<PolicyInfo["source"], string> = {
  override: "#4aa8ff",
  bundled: "#8b95a7",
};

const TIER_COLOR: Record<RepoTierInfo["tier"], string> = {
  advisory: "#8b95a7",
  issues: "#4aa8ff",
  pr: "#4ade80",
  automerge: "#f6c350",
};

const ACTION_COLOR: Record<string, string> = {
  createPR: "#4ade80",
  push: "#4aa8ff",
  merge: "#f6c350",
};

function SkippedJobs({ jobs }: { jobs: string[] }) {
  if (jobs.length === 0) return <span className="text-muted">none</span>;
  return (
    <div className="flex max-w-[520px] flex-wrap gap-1.5">
      {jobs.map((job) => (
        <Badge key={job} className="font-mono">{job}</Badge>
      ))}
    </div>
  );
}

export function Policies() {
  const { data, isLoading } = usePolicies();

  const policyCols: Column<PolicyInfo>[] = [
    { key: "name", header: "Policy", cell: (p) => <span className="font-medium text-text">{p.name}</span> },
    { key: "source", header: "Source", cell: (p) => <Badge color={SOURCE_COLOR[p.source]}>{p.source}</Badge> },
    { key: "path", header: "Resolved path", className: "min-w-[360px]", cell: (p) => <span className="break-all font-mono text-[12px] text-muted">{p.path}</span> },
  ];

  const repoCols: Column<RepoTierInfo>[] = [
    { key: "repo", header: "Repository", cell: (r) => <span className="font-medium text-text">{r.fullName}</span> },
    { key: "tier", header: "Tier", cell: (r) => <Badge color={TIER_COLOR[r.tier]}>{r.tier}</Badge> },
    { key: "source", header: "Source", cell: (r) => <span className="text-secondary">{r.tierSource}</span> },
    { key: "skipped", header: "Jobs skipped at this tier", cell: (r) => <SkippedJobs jobs={r.skippedJobs} /> },
  ];

  const gateCols: Column<JobGate>[] = [
    { key: "job", header: "Job", cell: (g) => <span className="font-medium text-text">{g.job}</span> },
    { key: "action", header: "Action", cell: (g) => <Badge color={ACTION_COLOR[g.action]}>{g.action}</Badge> },
    { key: "required", header: "Required tier", cell: (g) => <Badge color={TIER_COLOR[g.requiredTier]}>{g.requiredTier}</Badge> },
  ];

  if (isLoading || !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10" />
        <Skeleton className="h-40" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[20px] font-semibold text-text">Policies</h1>
        <p className="text-[13px] text-muted">
          {data.policies.length} loaded · default autonomy {data.defaultAutonomy}
        </p>
      </header>

      <section>
        <SectionHeader label="Loaded Policies" />
        <DataTable
          columns={policyCols}
          rows={data.policies}
          rowKey={(p) => p.name}
          empty={<EmptyState title="No loaded policies" />}
        />
      </section>

      <section>
        <SectionHeader label="Effective Autonomy" />
        <DataTable
          columns={repoCols}
          rows={data.repos}
          rowKey={(r) => r.fullName}
          empty={<EmptyState title="No configured repositories" />}
        />
      </section>

      <section>
        <SectionHeader label="Gated Jobs" />
        <DataTable
          columns={gateCols}
          rows={data.jobGates}
          rowKey={(g) => g.job}
          empty={<EmptyState title="No gated jobs" />}
        />
      </section>
    </div>
  );
}
