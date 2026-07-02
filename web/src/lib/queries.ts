import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

export const useSession = () => useQuery({ queryKey: ["session"], queryFn: api.session, staleTime: 30_000, retry: false });
export const useOverview = () => useQuery({ queryKey: ["overview"], queryFn: api.overview, refetchInterval: 10_000 });
export const useJobs = () => useQuery({ queryKey: ["jobs"], queryFn: api.jobs, refetchInterval: 10_000 });
export const useQueue = () => useQuery({ queryKey: ["queue"], queryFn: api.queue, refetchInterval: 60_000 });
export const useConfig = () => useQuery({ queryKey: ["config"], queryFn: api.config });
export const useRepos = () => useQuery({ queryKey: ["repos"], queryFn: api.repos, refetchInterval: 60_000 });
export const useNotifications = () => useQuery({ queryKey: ["notifications"], queryFn: () => api.notifications(), refetchInterval: 30_000 });
export const useLearnings = () => useQuery({ queryKey: ["learnings"], queryFn: () => api.learnings(), refetchInterval: 60_000 });

export const useRuns = (params: { job?: string; search?: string } = {}) =>
  useQuery({ queryKey: ["runs", params], queryFn: () => api.runs(params), refetchInterval: 30_000 });

export const useRun = (runId: string) =>
  useQuery({ queryKey: ["run", runId], queryFn: () => api.run(runId), enabled: !!runId });

export const useIssueLogs = (repo: string, number: number) =>
  useQuery({ queryKey: ["issueLogs", repo, number], queryFn: () => api.issueLogs(repo, number), enabled: !!repo && number > 0, refetchInterval: 30_000 });

// ── Mutations ──

export function useJobActions() {
  const qc = useQueryClient();
  const invalidate = () => { qc.invalidateQueries({ queryKey: ["jobs"] }); qc.invalidateQueries({ queryKey: ["overview"] }); };
  const trigger = useMutation({ mutationFn: api.triggerJob, onSuccess: invalidate });
  const pause = useMutation({ mutationFn: api.pauseJob, onSuccess: invalidate });
  const cancel = useMutation({ mutationFn: api.cancelTask, onSuccess: invalidate });
  return { trigger, pause, cancel };
}

export function useQueueActions() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["queue"] });
  const merge = useMutation({ mutationFn: (v: { repo: string; prNumber: number }) => api.mergePR(v.repo, v.prNumber), onSuccess: invalidate });
  const action = useMutation({
    mutationFn: (v: { action: "skip" | "unskip" | "prioritize" | "deprioritize"; repo: string; number: number }) =>
      api.queueAction(v.action, v.repo, v.number),
    onSuccess: invalidate,
  });
  return { merge, action };
}

export function useDismissLearning() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: number; reason?: string }) => api.dismissLearning(v.id, v.reason),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["learnings"] }); qc.invalidateQueries({ queryKey: ["overview"] }); },
  });
}

export function useAddRepo() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: api.addRepo, onSuccess: () => qc.invalidateQueries({ queryKey: ["repos"] }) });
}

export function useSaveConfig() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: api.saveConfig, onSuccess: () => qc.invalidateQueries({ queryKey: ["config"] }) });
}
