import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import type { Overview as OverviewData } from "../lib/types";
import { Overview } from "./Overview";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Overview update check button", () => {
  it("renders the button and requests an update check", async () => {
    vi.spyOn(api, "overview").mockResolvedValue(overviewData());
    vi.spyOn(api, "runs").mockResolvedValue({ runs: [], jobNames: [], workItems: {}, recentItems: [] });
    const checkForUpdates = vi.spyOn(api, "checkForUpdates").mockResolvedValue({ result: "requested" });

    renderOverview();

    const button = await screen.findByRole("button", { name: /check for updates/i });
    await userEvent.click(button);

    await waitFor(() => expect(checkForUpdates).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: /check requested/i })).toBeInTheDocument();
  });
});

function renderOverview() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Overview />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function overviewData(): OverviewData {
  return {
    status: "ok",
    version: "test",
    startedAt: "2026-01-01T00:00:00.000Z",
    uptime: 120,
    jobs: {},
    pausedJobs: [],
    claudeQueue: { pending: 0, active: 0 },
    copilotQueue: { pending: 0, active: 0 },
    codexQueue: { pending: 0, active: 0 },
    runningTasks: [],
    jobSchedules: {},
    jobAi: {},
    discord: { configured: false, connected: false, lastResult: null },
    counts: {
      running: 0,
      queuePending: 0,
      queueBlockedByTier: 0,
      recentDone: 0,
      recentFailed: 0,
      pendingLearnings: 0,
    },
    system: {
      cpuPercent: null,
      cpuCount: 2,
      load: [0, 0, 0],
      memTotal: 1024,
      memUsed: 256,
      diskTotal: 1024,
      diskUsed: 256,
    },
    updatePending: false,
    pendingUpdateTag: null,
  };
}
