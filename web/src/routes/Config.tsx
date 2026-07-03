import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus, Save, Trash2 } from "lucide-react";
import { useConfig, useJobs, useSaveConfig } from "../lib/queries";
import type { AiBackend } from "../lib/types";
import { Tabs, TabPanel } from "../components/ui/Tabs";
import { Card, Button, Skeleton, SectionHeader } from "../components/ui/base";
import { Field, TextInput, SelectInput, Toggle } from "../components/ui/FormField";

const TABS = [
  { value: "general", label: "General" },
  { value: "scheduling", label: "Scheduling" },
  { value: "ai", label: "AI" },
  { value: "integrations", label: "Integrations" },
  { value: "security", label: "Security" },
];
const LOG_LEVELS = ["debug", "info", "warn", "error"];
const AUTONOMY_TIERS = ["advisory", "issues", "pr", "automerge"] as const;
const AI_BACKENDS = ["claude", "copilot", "codex"] as const;
const MASK = "•••• (set — leave blank to keep)";

type AutonomyTier = (typeof AUTONOMY_TIERS)[number];
type AutonomyRow = { repo: string; tier: AutonomyTier };
type JobConfigMap = Record<string, { backend: AiBackend; model: string; enabled: boolean }>;
type Draft = Record<string, unknown>;
const num = (v: unknown, d = 0) => (typeof v === "number" ? v : d);
const csv = (v: unknown) => (Array.isArray(v) ? v.join(", ") : "");
const toList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const isMasked = (v: unknown) => typeof v === "string" && v.length > 0 && v !== "Not configured";
const isAutonomyTier = (v: unknown): v is AutonomyTier =>
  typeof v === "string" && (AUTONOMY_TIERS as readonly string[]).includes(v);
const autonomyRows = (v: unknown): AutonomyRow[] =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.entries(v as Record<string, unknown>)
      .filter((entry): entry is [string, AutonomyTier] => isAutonomyTier(entry[1]))
      .map(([repo, tier]) => ({ repo, tier }))
    : [];

export function Config() {
  const { data, isLoading } = useConfig();
  const { data: jobs } = useJobs();
  const cfg = data?.values;
  const env = data?.envOverrides ?? {};
  const save = useSaveConfig();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "general";
  const [draft, setDraft] = useState<Draft>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!cfg) return;
    const intervals = (cfg.intervals as Record<string, number>) ?? {};
    const schedules = (cfg.schedules as Record<string, number>) ?? {};
    setDraft((d) => ({
      jobConfig: d.jobConfig,
      githubOwners: csv(cfg.githubOwners),
      selfRepo: cfg.selfRepo ?? "",
      logLevel: cfg.logLevel ?? "info",
      logRetentionDays: num(cfg.logRetentionDays, 14),
      logRetentionPerJob: num(cfg.logRetentionPerJob, 20),
      queueScanIntervalMin: Math.round(num(cfg.queueScanIntervalMs, 0) / 60000),
      includeForks: !!cfg.includeForks,
      reviewLoop: !!cfg.reviewLoop,
      defaultAutonomy: cfg.defaultAutonomy ?? "pr",
      autonomyRows: autonomyRows(cfg.autonomy),
      maxPlanRounds: num(cfg.maxPlanRounds, 3),
      learningsPendingThreshold: num(cfg.learningsPendingThreshold, 5),
      intervalsMin: Object.fromEntries(Object.entries(intervals).map(([k, v]) => [k, Math.round(v / 60000)])),
      schedules: { ...schedules },
      maxClaudeWorkers: num(cfg.maxClaudeWorkers, 2),
      maxCopilotWorkers: num(cfg.maxCopilotWorkers, 1),
      maxCodexWorkers: num(cfg.maxCodexWorkers, 1),
      allowedRepos: csv(cfg.allowedRepos),
      discordChannelId: cfg.discordChannelId ?? "",
      discordAllowedUsers: csv(cfg.discordAllowedUsers),
      discordBotToken: "",
      authToken: "",
    }));
  }, [cfg]);

  useEffect(() => {
    if (!jobs) return;
    setDraft((d) => {
      const existing = (d.jobConfig as JobConfigMap | undefined) ?? {};
      let changed = false;
      const next: JobConfigMap = { ...existing };
      for (const job of jobs) {
        if (!(job.name in existing)) {
          next[job.name] = {
            backend: job.backend,
            model: job.model ?? "",
            enabled: job.enabled,
          };
          changed = true;
        }
      }
      return changed ? { ...d, jobConfig: next } : d;
    });
  }, [jobs]);

  if (isLoading || !cfg) return <Skeleton className="h-64" />;

  const lock = (field: string): string | undefined => env[field];
  const set = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }));
  const setNested = (parent: string, k: string, v: number) =>
    setDraft((d) => ({ ...d, [parent]: { ...(d[parent] as Record<string, number>), [k]: v } }));
  const setJob = (name: string, patch: Partial<JobConfigMap[string]>) =>
    setDraft((d) => {
      const jobConfig = (d.jobConfig as JobConfigMap | undefined) ?? {};
      const current = jobConfig[name];
      if (!current) return d;
      return { ...d, jobConfig: { ...jobConfig, [name]: { ...current, ...patch } } };
    });
  const setAutonomyRows = (rows: AutonomyRow[]) => set("autonomyRows", rows);
  const rows = (draft.autonomyRows as AutonomyRow[] | undefined) ?? [];
  const jobConfig = (draft.jobConfig as JobConfigMap | undefined) ?? {};
  const jobRows = Object.entries(jobConfig).sort(([a], [b]) => a.localeCompare(b));

  const onSave = async () => {
    const d = draft;
    const jc = (d.jobConfig as JobConfigMap | undefined) ?? {};
    const jobNames = Object.keys(jc);
    const autonomy = Object.fromEntries(
      ((d.autonomyRows as AutonomyRow[] | undefined) ?? [])
        .map((row) => [row.repo.trim(), row.tier])
        .filter(([repo]) => repo),
    );
    const intervalsMs = Object.fromEntries(
      Object.entries(d.intervalsMin as Record<string, number>).map(([k, v]) => [k, v * 60000]),
    );
    const payload: Record<string, unknown> = {
      _tab: tab,
      githubOwners: toList(d.githubOwners as string),
      selfRepo: d.selfRepo,
      logLevel: d.logLevel,
      logRetentionDays: Number(d.logRetentionDays),
      logRetentionPerJob: Number(d.logRetentionPerJob),
      queueScanIntervalMs: Number(d.queueScanIntervalMin) * 60000,
      includeForks: d.includeForks,
      reviewLoop: d.reviewLoop,
      defaultAutonomy: d.defaultAutonomy,
      autonomy,
      maxPlanRounds: Number(d.maxPlanRounds),
      learningsPendingThreshold: Number(d.learningsPendingThreshold),
      intervals: intervalsMs,
      schedules: d.schedules,
      maxClaudeWorkers: Number(d.maxClaudeWorkers),
      maxCopilotWorkers: Number(d.maxCopilotWorkers),
      maxCodexWorkers: Number(d.maxCodexWorkers),
      allowedRepos: toList(d.allowedRepos as string),
      discordChannelId: d.discordChannelId,
      discordAllowedUsers: toList(d.discordAllowedUsers as string),
    };
    if (jobNames.length > 0) {
      payload.enabledJobs = jobNames.filter((name) => jc[name].enabled);
      payload.jobAi = Object.fromEntries(jobNames.map((name) => {
        const model = jc[name].model.trim();
        return [name, model ? { backend: jc[name].backend, model } : { backend: jc[name].backend }];
      }));
    }
    if (d.discordBotToken) payload.discordBotToken = d.discordBotToken;
    if (d.authToken) payload.authToken = d.authToken;
    // Don't submit env-locked fields (the server ignores them anyway).
    for (const field of Object.keys(env)) delete payload[field];
    await save.mutateAsync(payload);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-[20px] font-semibold text-text">Configuration</h1>
          <p className="text-[13px] text-muted">Changes apply live (no restart for most fields)</p>
        </div>
        <div className="flex items-center gap-3">
          {saved && <span className="text-[12px] text-success">Saved & applied</span>}
          <Button variant="primary" size="md" onClick={onSave} loading={save.isPending}><Save size={14} /> Save</Button>
        </div>
      </header>

      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v }, { replace: true })} tabs={TABS}>
        <TabPanel value="general">
          <Card className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
            <Field label="GitHub owners (comma-separated)" envVar={lock("githubOwners")}><TextInput value={draft.githubOwners as string ?? ""} disabled={!!lock("githubOwners")} onChange={(e) => set("githubOwners", e.target.value)} /></Field>
            <Field label="Self repo" envVar={lock("selfRepo")}><TextInput value={draft.selfRepo as string ?? ""} disabled={!!lock("selfRepo")} onChange={(e) => set("selfRepo", e.target.value)} /></Field>
            <Field label="Log level" envVar={lock("logLevel")}>
              <SelectInput value={draft.logLevel as string} disabled={!!lock("logLevel")} onChange={(e) => set("logLevel", e.target.value)}>
                {LOG_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
              </SelectInput>
            </Field>
            <Field label="Queue scan interval (minutes)"><TextInput type="number" value={String(draft.queueScanIntervalMin ?? 0)} onChange={(e) => set("queueScanIntervalMin", e.target.value)} /></Field>
            <Field label="Log retention (days)"><TextInput type="number" value={String(draft.logRetentionDays ?? 0)} onChange={(e) => set("logRetentionDays", e.target.value)} /></Field>
            <Field label="Log retention (per job)"><TextInput type="number" value={String(draft.logRetentionPerJob ?? 0)} onChange={(e) => set("logRetentionPerJob", e.target.value)} /></Field>
            <Field label="Max plan rounds"><TextInput type="number" value={String(draft.maxPlanRounds ?? 3)} onChange={(e) => set("maxPlanRounds", e.target.value)} /></Field>
            <Field label="Learnings PR threshold"><TextInput type="number" min={1} value={String(draft.learningsPendingThreshold ?? 5)} onChange={(e) => set("learningsPendingThreshold", e.target.value)} /></Field>
            <div className="flex flex-col gap-1">
              <div className="flex items-end gap-6">
                <Toggle label="Include forks" checked={!!draft.includeForks} disabled={!!lock("includeForks")} onChange={(v) => set("includeForks", v)} />
                <Toggle label="Review loop" checked={!!draft.reviewLoop} onChange={(v) => set("reviewLoop", v)} />
              </div>
              {lock("includeForks") && <span className="text-[11px] text-warning">Include forks set via env var {lock("includeForks")}.</span>}
            </div>
          </Card>
        </TabPanel>

        <TabPanel value="scheduling">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Card className="p-4">
              <SectionHeader label="Intervals (minutes)" />
              <div className="grid grid-cols-1 gap-3">
                {Object.entries((draft.intervalsMin as Record<string, number>) ?? {}).map(([k, v]) => (
                  <Field key={k} label={k}><TextInput type="number" value={String(v)} onChange={(e) => setNested("intervalsMin", k, Number(e.target.value))} /></Field>
                ))}
              </div>
            </Card>
            <Card className="p-4">
              <SectionHeader label="Daily schedules (hour 0–23)" />
              <div className="grid grid-cols-1 gap-3">
                {Object.entries((draft.schedules as Record<string, number>) ?? {}).map(([k, v]) => (
                  <Field key={k} label={k}><TextInput type="number" min={0} max={23} value={String(v)} onChange={(e) => setNested("schedules", k, Number(e.target.value))} /></Field>
                ))}
              </div>
            </Card>
          </div>
        </TabPanel>

        <TabPanel value="ai">
          <div className="space-y-4">
            <Card className="grid grid-cols-1 gap-4 p-4 md:grid-cols-3">
              <Field label="Max Claude workers" envVar={lock("maxClaudeWorkers")}><TextInput type="number" value={String(draft.maxClaudeWorkers ?? 0)} disabled={!!lock("maxClaudeWorkers")} onChange={(e) => set("maxClaudeWorkers", e.target.value)} /></Field>
              <Field label="Max Copilot workers" envVar={lock("maxCopilotWorkers")}><TextInput type="number" value={String(draft.maxCopilotWorkers ?? 0)} disabled={!!lock("maxCopilotWorkers")} onChange={(e) => set("maxCopilotWorkers", e.target.value)} /></Field>
              <Field label="Max Codex workers" envVar={lock("maxCodexWorkers")}><TextInput type="number" value={String(draft.maxCodexWorkers ?? 0)} disabled={!!lock("maxCodexWorkers")} onChange={(e) => set("maxCodexWorkers", e.target.value)} /></Field>
            </Card>
            <Card className="p-4">
              <SectionHeader label="Job Configuration" />
              {jobRows.length === 0 ? (
                <div className="rounded-md border border-dashed border-border px-3 py-4 text-[12px] text-muted">
                  Loading jobs...
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <div className="min-w-[640px]">
                    <div className="grid grid-cols-[minmax(0,1fr)_140px_minmax(180px,1fr)_92px] gap-2 text-[12px] font-medium text-secondary">
                      <span>Job</span>
                      <span>Backend</span>
                      <span>Model</span>
                      <span>Enabled</span>
                    </div>
                    <div className="mt-2 grid grid-cols-1 gap-2">
                      {jobRows.map(([name, job]) => (
                        <div key={name} className="grid grid-cols-[minmax(0,1fr)_140px_minmax(180px,1fr)_92px] items-center gap-2">
                          <div className="truncate text-[13px] font-medium text-text" title={name}>{name}</div>
                          <SelectInput
                            aria-label={`${name} backend`}
                            value={job.backend}
                            onChange={(e) => setJob(name, { backend: e.target.value as AiBackend })}
                          >
                            {AI_BACKENDS.map((backend) => <option key={backend} value={backend}>{backend}</option>)}
                          </SelectInput>
                          <TextInput
                            aria-label={`${name} model`}
                            placeholder="default"
                            value={job.model}
                            onChange={(e) => setJob(name, { model: e.target.value })}
                          />
                          <Toggle label="Enabled" checked={job.enabled} onChange={(v) => setJob(name, { enabled: v })} />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </Card>
          </div>
        </TabPanel>

        <TabPanel value="integrations">
          <Card className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
            <Field label="Discord bot token" envVar={lock("discordBotToken")} hint={isMasked(cfg.discordBotToken) ? "A token is currently set." : undefined}>
              <TextInput type="password" placeholder={isMasked(cfg.discordBotToken) ? MASK : "Not set"} value={draft.discordBotToken as string ?? ""} disabled={!!lock("discordBotToken")} onChange={(e) => set("discordBotToken", e.target.value)} />
            </Field>
            <Field label="Discord channel ID" envVar={lock("discordChannelId")}><TextInput value={draft.discordChannelId as string ?? ""} disabled={!!lock("discordChannelId")} onChange={(e) => set("discordChannelId", e.target.value)} /></Field>
            <Field label="Discord allowed users (comma-separated)" envVar={lock("discordAllowedUsers")}><TextInput value={draft.discordAllowedUsers as string ?? ""} disabled={!!lock("discordAllowedUsers")} onChange={(e) => set("discordAllowedUsers", e.target.value)} /></Field>
          </Card>
        </TabPanel>

        <TabPanel value="security">
          <Card className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
            <Field label="Auth token" envVar={lock("authToken")} hint={isMasked(cfg.authToken) ? "A token is currently set." : undefined}>
              <TextInput type="password" placeholder={isMasked(cfg.authToken) ? MASK : "Not set"} value={draft.authToken as string ?? ""} disabled={!!lock("authToken")} onChange={(e) => set("authToken", e.target.value)} />
            </Field>
            <Field label="Allowed repos (comma-separated)" envVar={lock("allowedRepos")}><TextInput value={draft.allowedRepos as string ?? ""} disabled={!!lock("allowedRepos")} onChange={(e) => set("allowedRepos", e.target.value)} /></Field>
            <Field label="Default autonomy tier" hint="advisory: comments/labels only -> issues: can open issues -> pr: can push and open PRs -> automerge: can merge.">
              <SelectInput value={draft.defaultAutonomy as string ?? "pr"} onChange={(e) => set("defaultAutonomy", e.target.value)}>
                {AUTONOMY_TIERS.map((tier) => <option key={tier} value={tier}>{tier}</option>)}
              </SelectInput>
            </Field>
            <div className="md:col-span-2">
              <SectionHeader
                label="Per-repo autonomy overrides"
                action={
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => setAutonomyRows([...rows, { repo: "", tier: "advisory" }])}
                  >
                    <Plus size={13} /> Add row
                  </Button>
                }
              />
              <div className="grid grid-cols-[minmax(0,1fr)_140px_32px] gap-2 text-[12px] font-medium text-secondary">
                <span>Repo fullName</span>
                <span>Tier</span>
                <span />
              </div>
              <div className="mt-2 grid grid-cols-1 gap-2">
                {rows.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border px-3 py-4 text-[12px] text-muted">
                    No per-repo overrides.
                  </div>
                ) : rows.map((row, index) => (
                  <div key={index} className="grid grid-cols-[minmax(0,1fr)_140px_32px] gap-2">
                    <TextInput
                      value={row.repo}
                      placeholder="owner/repo"
                      onChange={(e) => setAutonomyRows(rows.map((r, i) => i === index ? { ...r, repo: e.target.value } : r))}
                    />
                    <SelectInput
                      value={row.tier}
                      onChange={(e) => setAutonomyRows(rows.map((r, i) => i === index ? { ...r, tier: e.target.value as AutonomyTier } : r))}
                    >
                      {AUTONOMY_TIERS.map((tier) => <option key={tier} value={tier}>{tier}</option>)}
                    </SelectInput>
                    <Button
                      type="button"
                      variant="danger"
                      className="h-8 px-0"
                      aria-label={`Remove autonomy override ${row.repo || index + 1}`}
                      onClick={() => setAutonomyRows(rows.filter((_, i) => i !== index))}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        </TabPanel>
      </Tabs>
    </div>
  );
}
