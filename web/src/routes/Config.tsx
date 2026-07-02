import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Save } from "lucide-react";
import { useConfig, useSaveConfig } from "../lib/queries";
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
const MASK = "•••• (set — leave blank to keep)";

type Draft = Record<string, unknown>;
const num = (v: unknown, d = 0) => (typeof v === "number" ? v : d);
const csv = (v: unknown) => (Array.isArray(v) ? v.join(", ") : "");
const toList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const isMasked = (v: unknown) => typeof v === "string" && v.length > 0 && v !== "Not configured";

export function Config() {
  const { data: cfg, isLoading } = useConfig();
  const save = useSaveConfig();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "general";
  const [draft, setDraft] = useState<Draft>({});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!cfg) return;
    const intervals = (cfg.intervals as Record<string, number>) ?? {};
    const schedules = (cfg.schedules as Record<string, number>) ?? {};
    setDraft({
      githubOwners: csv(cfg.githubOwners),
      selfRepo: cfg.selfRepo ?? "",
      logLevel: cfg.logLevel ?? "info",
      logRetentionDays: num(cfg.logRetentionDays, 14),
      logRetentionPerJob: num(cfg.logRetentionPerJob, 20),
      queueScanIntervalMin: Math.round(num(cfg.queueScanIntervalMs, 0) / 60000),
      includeForks: !!cfg.includeForks,
      reviewLoop: !!cfg.reviewLoop,
      maxPlanRounds: num(cfg.maxPlanRounds, 3),
      intervalsMin: Object.fromEntries(Object.entries(intervals).map(([k, v]) => [k, Math.round(v / 60000)])),
      schedules: { ...schedules },
      maxClaudeWorkers: num(cfg.maxClaudeWorkers, 2),
      maxCopilotWorkers: num(cfg.maxCopilotWorkers, 1),
      maxCodexWorkers: num(cfg.maxCodexWorkers, 1),
      enabledJobs: csv(cfg.enabledJobs),
      allowedRepos: csv(cfg.allowedRepos),
      discordChannelId: cfg.discordChannelId ?? "",
      discordAllowedUsers: csv(cfg.discordAllowedUsers),
      discordBotToken: "",
      authToken: "",
    });
  }, [cfg]);

  if (isLoading || !cfg) return <Skeleton className="h-64" />;

  const set = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }));
  const setNested = (parent: string, k: string, v: number) =>
    setDraft((d) => ({ ...d, [parent]: { ...(d[parent] as Record<string, number>), [k]: v } }));

  const onSave = async () => {
    const d = draft;
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
      maxPlanRounds: Number(d.maxPlanRounds),
      intervals: intervalsMs,
      schedules: d.schedules,
      maxClaudeWorkers: Number(d.maxClaudeWorkers),
      maxCopilotWorkers: Number(d.maxCopilotWorkers),
      maxCodexWorkers: Number(d.maxCodexWorkers),
      enabledJobs: toList(d.enabledJobs as string),
      allowedRepos: toList(d.allowedRepos as string),
      discordChannelId: d.discordChannelId,
      discordAllowedUsers: toList(d.discordAllowedUsers as string),
    };
    if (d.discordBotToken) payload.discordBotToken = d.discordBotToken;
    if (d.authToken) payload.authToken = d.authToken;
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
            <Field label="GitHub owners (comma-separated)"><TextInput value={draft.githubOwners as string ?? ""} onChange={(e) => set("githubOwners", e.target.value)} /></Field>
            <Field label="Self repo"><TextInput value={draft.selfRepo as string ?? ""} onChange={(e) => set("selfRepo", e.target.value)} /></Field>
            <Field label="Log level">
              <SelectInput value={draft.logLevel as string} onChange={(e) => set("logLevel", e.target.value)}>
                {LOG_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
              </SelectInput>
            </Field>
            <Field label="Queue scan interval (minutes)"><TextInput type="number" value={String(draft.queueScanIntervalMin ?? 0)} onChange={(e) => set("queueScanIntervalMin", e.target.value)} /></Field>
            <Field label="Log retention (days)"><TextInput type="number" value={String(draft.logRetentionDays ?? 0)} onChange={(e) => set("logRetentionDays", e.target.value)} /></Field>
            <Field label="Log retention (per job)"><TextInput type="number" value={String(draft.logRetentionPerJob ?? 0)} onChange={(e) => set("logRetentionPerJob", e.target.value)} /></Field>
            <Field label="Max plan rounds"><TextInput type="number" value={String(draft.maxPlanRounds ?? 3)} onChange={(e) => set("maxPlanRounds", e.target.value)} /></Field>
            <div className="flex items-end gap-6">
              <Toggle label="Include forks" checked={!!draft.includeForks} onChange={(v) => set("includeForks", v)} />
              <Toggle label="Review loop" checked={!!draft.reviewLoop} onChange={(v) => set("reviewLoop", v)} />
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
          <Card className="grid grid-cols-1 gap-4 p-4 md:grid-cols-3">
            <Field label="Max Claude workers"><TextInput type="number" value={String(draft.maxClaudeWorkers ?? 0)} onChange={(e) => set("maxClaudeWorkers", e.target.value)} /></Field>
            <Field label="Max Copilot workers"><TextInput type="number" value={String(draft.maxCopilotWorkers ?? 0)} onChange={(e) => set("maxCopilotWorkers", e.target.value)} /></Field>
            <Field label="Max Codex workers"><TextInput type="number" value={String(draft.maxCodexWorkers ?? 0)} onChange={(e) => set("maxCodexWorkers", e.target.value)} /></Field>
          </Card>
        </TabPanel>

        <TabPanel value="integrations">
          <Card className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
            <Field label="Discord bot token" hint={isMasked(cfg.discordBotToken) ? "A token is currently set." : undefined}>
              <TextInput type="password" placeholder={isMasked(cfg.discordBotToken) ? MASK : "Not set"} value={draft.discordBotToken as string ?? ""} onChange={(e) => set("discordBotToken", e.target.value)} />
            </Field>
            <Field label="Discord channel ID"><TextInput value={draft.discordChannelId as string ?? ""} onChange={(e) => set("discordChannelId", e.target.value)} /></Field>
            <Field label="Discord allowed users (comma-separated)"><TextInput value={draft.discordAllowedUsers as string ?? ""} onChange={(e) => set("discordAllowedUsers", e.target.value)} /></Field>
          </Card>
        </TabPanel>

        <TabPanel value="security">
          <Card className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
            <Field label="Auth token" hint={isMasked(cfg.authToken) ? "A token is currently set." : undefined}>
              <TextInput type="password" placeholder={isMasked(cfg.authToken) ? MASK : "Not set"} value={draft.authToken as string ?? ""} onChange={(e) => set("authToken", e.target.value)} />
            </Field>
            <Field label="Enabled jobs (comma-separated)"><TextInput value={draft.enabledJobs as string ?? ""} onChange={(e) => set("enabledJobs", e.target.value)} /></Field>
            <Field label="Allowed repos (comma-separated)"><TextInput value={draft.allowedRepos as string ?? ""} onChange={(e) => set("allowedRepos", e.target.value)} /></Field>
          </Card>
        </TabPanel>
      </Tabs>
    </div>
  );
}
