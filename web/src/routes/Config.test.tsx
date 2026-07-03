import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import type { ConfigResponse, Job } from "../lib/types";
import { Config } from "./Config";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Config job configuration", () => {
  it("renders job configuration rows in the AI tab", async () => {
    vi.spyOn(api, "config").mockResolvedValue(configData());
    vi.spyOn(api, "jobs").mockResolvedValue(jobsData());
    vi.spyOn(api, "saveConfig").mockResolvedValue({ saved: true, tab: "ai" });

    renderConfig("/config?tab=ai");

    expect(await screen.findByText("Job Configuration")).toBeInTheDocument();
    expect(screen.getByText("issue-refiner")).toBeInTheDocument();
    expect(screen.getByText("plan-reviewer")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "issue-refiner backend" })).toHaveValue("copilot");
    expect(screen.getByRole("textbox", { name: "issue-refiner model" })).toHaveValue("claude-opus-4.7");
    expect(screen.getByRole("combobox", { name: "plan-reviewer backend" })).toHaveValue("claude");
    expect(screen.getByRole("textbox", { name: "plan-reviewer model" })).toHaveValue("");
  });

  it("does not render the old enabled jobs field in the Security tab", async () => {
    vi.spyOn(api, "config").mockResolvedValue(configData());
    vi.spyOn(api, "jobs").mockResolvedValue(jobsData());
    vi.spyOn(api, "saveConfig").mockResolvedValue({ saved: true, tab: "security" });

    renderConfig("/config?tab=security");

    expect(await screen.findByLabelText("Auth token")).toBeInTheDocument();
    expect(screen.queryByLabelText("Enabled jobs (comma-separated)")).not.toBeInTheDocument();
  });

  it("preserves unsaved job edits across jobs refetches", async () => {
    vi.spyOn(api, "config").mockResolvedValue(configData());
    vi.spyOn(api, "jobs").mockResolvedValue(jobsData());
    vi.spyOn(api, "saveConfig").mockResolvedValue({ saved: true, tab: "ai" });
    const { client } = renderConfig("/config?tab=ai");
    const user = userEvent.setup();

    const backend = await screen.findByRole("combobox", { name: "issue-refiner backend" });
    await user.selectOptions(backend, "codex");
    await user.clear(screen.getByRole("textbox", { name: "issue-refiner model" }));
    await user.type(screen.getByRole("textbox", { name: "issue-refiner model" }), "gpt-5-codex");

    client.setQueryData(["jobs"], jobsData(99));

    expect(screen.getByRole("combobox", { name: "issue-refiner backend" })).toHaveValue("codex");
    expect(screen.getByRole("textbox", { name: "issue-refiner model" })).toHaveValue("gpt-5-codex");
  });

  it("preserves unsaved job edits across config refetches", async () => {
    vi.spyOn(api, "config").mockResolvedValue(configData());
    vi.spyOn(api, "jobs").mockResolvedValue(jobsData());
    vi.spyOn(api, "saveConfig").mockResolvedValue({ saved: true, tab: "ai" });
    const { client } = renderConfig("/config?tab=ai");
    const user = userEvent.setup();

    const backend = await screen.findByRole("combobox", { name: "issue-refiner backend" });
    await user.selectOptions(backend, "codex");

    client.setQueryData(["config"], configData({ logLevel: "debug" }));

    expect(screen.getByRole("combobox", { name: "issue-refiner backend" })).toHaveValue("codex");
  });

  it("omits job fields when saving before jobs have loaded", async () => {
    vi.spyOn(api, "config").mockResolvedValue(configData());
    vi.spyOn(api, "jobs").mockReturnValue(new Promise<Job[]>(() => {}));
    const saveConfig = vi.spyOn(api, "saveConfig").mockResolvedValue({ saved: true, tab: "ai" });
    const user = userEvent.setup();

    renderConfig("/config?tab=ai");

    await screen.findByText("Loading jobs...");
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(1));
    const payload = saveConfig.mock.calls[0][0];
    expect(payload).not.toHaveProperty("enabledJobs");
    expect(payload).not.toHaveProperty("jobAi");
  });

  it("saves enabled jobs and per-job AI settings when jobs are loaded", async () => {
    vi.spyOn(api, "config").mockResolvedValue(configData());
    vi.spyOn(api, "jobs").mockResolvedValue(jobsData());
    const saveConfig = vi.spyOn(api, "saveConfig").mockResolvedValue({ saved: true, tab: "ai" });
    const user = userEvent.setup();

    renderConfig("/config?tab=ai");

    await screen.findByText("Job Configuration");
    await user.selectOptions(screen.getByRole("combobox", { name: "plan-reviewer backend" }), "codex");
    await user.type(screen.getByRole("textbox", { name: "plan-reviewer model" }), "gpt-5-codex");
    const checkboxes = screen.getAllByRole("checkbox", { name: "Enabled" });
    await user.click(checkboxes[0]);

    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(saveConfig).toHaveBeenCalledTimes(1));
    expect(saveConfig.mock.calls[0][0]).toMatchObject({
      enabledJobs: [],
      jobAi: {
        "issue-refiner": { backend: "copilot", model: "claude-opus-4.7" },
        "plan-reviewer": { backend: "codex", model: "gpt-5-codex" },
      },
    });
  });
});

function renderConfig(initialEntry: string) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Config />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, client };
}

function configData(values: Record<string, unknown> = {}): ConfigResponse {
  return {
    values: {
      githubOwners: ["frostyard"],
      selfRepo: "frostyard/yeti",
      logLevel: "info",
      logRetentionDays: 14,
      logRetentionPerJob: 20,
      queueScanIntervalMs: 300000,
      includeForks: false,
      reviewLoop: true,
      defaultAutonomy: "pr",
      autonomy: {},
      maxPlanRounds: 3,
      learningsPendingThreshold: 5,
      intervals: { "issue-refiner": 300000 },
      schedules: { "doc-maintainer": 1 },
      maxClaudeWorkers: 2,
      maxCopilotWorkers: 1,
      maxCodexWorkers: 1,
      enabledJobs: ["issue-refiner"],
      allowedRepos: [],
      discordChannelId: "",
      discordAllowedUsers: [],
      discordBotToken: "Not configured",
      authToken: "Not configured",
      ...values,
    },
    envOverrides: {},
  };
}

function jobsData(nextRunIn = 30): Job[] {
  return [
    {
      name: "issue-refiner",
      description: "Refines issues",
      enabled: true,
      running: false,
      paused: false,
      backend: "copilot",
      model: "claude-opus-4.7",
      schedule: { intervalMs: 300000 },
      lastRun: null,
      nextRunIn,
    },
    {
      name: "plan-reviewer",
      description: "Reviews plans",
      enabled: false,
      running: false,
      paused: false,
      backend: "claude",
      model: null,
      schedule: { intervalMs: 600000 },
      lastRun: null,
      nextRunIn,
    },
  ];
}
