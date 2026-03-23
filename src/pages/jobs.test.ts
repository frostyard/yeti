import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  GITHUB_OWNERS: ["frostyard"],
}));

vi.mock("../scheduler.js", () => ({
  msUntilHour: vi.fn().mockReturnValue(3600000),
}));

import { buildJobsPage, type JobInfo } from "./jobs.js";

function makeJobs(): JobInfo[] {
  return [
    { name: "issue-worker", intervalMs: 300000 },
    { name: "doc-maintainer", intervalMs: 0, scheduledHour: 1 },
    { name: "ci-fixer", intervalMs: 600000 },
  ];
}

describe("buildJobsPage", () => {
  const defaultArgs = () => ({
    allJobs: makeJobs(),
    enabledJobs: new Set(["issue-worker", "ci-fixer"]),
    jobAi: {} as Readonly<Record<string, { backend?: "claude" | "copilot" | "codex"; model?: string }>>,
    runningJobs: { "issue-worker": true, "ci-fixer": false } as Record<string, boolean>,
    latestRuns: new Map([
      ["issue-worker", { runId: "run-1", status: "completed", startedAt: "2025-01-01 00:00:00", completedAt: "2025-01-01 00:01:00" }],
    ]),
    theme: "dark" as const,
    paused: new Set<string>(),
    scheduleInfo: new Map([
      ["issue-worker", { intervalMs: 300000 }],
      ["ci-fixer", { intervalMs: 600000 }],
    ]),
  });

  it("renders all job names including disabled ones", () => {
    const args = defaultArgs();
    const html = buildJobsPage(
      args.allJobs, args.enabledJobs, args.jobAi, args.runningJobs,
      args.latestRuns, args.theme, args.paused, args.scheduleInfo,
    );
    expect(html).toContain("issue-worker");
    expect(html).toContain("doc-maintainer");
    expect(html).toContain("ci-fixer");
  });

  it("shows enabled/disabled indicator correctly", () => {
    const args = defaultArgs();
    const html = buildJobsPage(
      args.allJobs, args.enabledJobs, args.jobAi, args.runningJobs,
      args.latestRuns, args.theme, args.paused, args.scheduleInfo,
    );
    // issue-worker and ci-fixer are enabled, doc-maintainer is disabled
    const parts = html.split("doc-maintainer");
    // The part after doc-maintainer should contain Disabled
    expect(parts[1]).toContain("Disabled");
  });

  it("shows backend from JOB_AI config", () => {
    const args = defaultArgs();
    args.jobAi = { "ci-fixer": { backend: "copilot" } };
    const html = buildJobsPage(
      args.allJobs, args.enabledJobs, args.jobAi, args.runningJobs,
      args.latestRuns, args.theme, args.paused, args.scheduleInfo,
    );
    expect(html).toContain("Copilot");
  });

  it("shows Claude as default backend", () => {
    const args = defaultArgs();
    const html = buildJobsPage(
      args.allJobs, args.enabledJobs, args.jobAi, args.runningJobs,
      args.latestRuns, args.theme, args.paused, args.scheduleInfo,
    );
    expect(html).toContain("Claude");
  });

  it("shows model override from JOB_AI", () => {
    const args = defaultArgs();
    args.jobAi = { "issue-worker": { model: "opus" } };
    const html = buildJobsPage(
      args.allJobs, args.enabledJobs, args.jobAi, args.runningJobs,
      args.latestRuns, args.theme, args.paused, args.scheduleInfo,
    );
    expect(html).toContain("opus");
  });

  it("shows 'default' when no model override", () => {
    const args = defaultArgs();
    const html = buildJobsPage(
      args.allJobs, args.enabledJobs, args.jobAi, args.runningJobs,
      args.latestRuns, args.theme, args.paused, args.scheduleInfo,
    );
    expect(html).toContain("default");
  });

  it("shows Run/Pause buttons only for enabled jobs", () => {
    const args = defaultArgs();
    const html = buildJobsPage(
      args.allJobs, args.enabledJobs, args.jobAi, args.runningJobs,
      args.latestRuns, args.theme, args.paused, args.scheduleInfo,
    );
    // Enabled jobs have trigger buttons
    expect(html).toContain("triggerJob('issue-worker'");
    expect(html).toContain("triggerJob('ci-fixer'");
    // Disabled jobs don't
    expect(html).not.toContain("triggerJob('doc-maintainer'");
  });

  it("shows disabled status for disabled jobs", () => {
    const args = defaultArgs();
    args.runningJobs = {};
    const html = buildJobsPage(
      args.allJobs, args.enabledJobs, args.jobAi, args.runningJobs,
      args.latestRuns, args.theme, args.paused, args.scheduleInfo,
    );
    // doc-maintainer is disabled — should show Disabled status
    expect(html).toContain("Disabled");
  });

  it("shows schedule info for all jobs", () => {
    const args = defaultArgs();
    const html = buildJobsPage(
      args.allJobs, args.enabledJobs, args.jobAi, args.runningJobs,
      args.latestRuns, args.theme, args.paused, args.scheduleInfo,
    );
    expect(html).toContain("Every 5 min");
    expect(html).toContain("Daily at 1:00");
    expect(html).toContain("Every 10 min");
  });

  it("falls back gracefully for unknown job names", () => {
    const args = defaultArgs();
    args.allJobs = [{ name: "unknown-job", intervalMs: 60000 }];
    args.enabledJobs = new Set(["unknown-job"]);
    const html = buildJobsPage(
      args.allJobs, args.enabledJobs, args.jobAi, args.runningJobs,
      args.latestRuns, args.theme, args.paused, args.scheduleInfo,
    );
    expect(html).toContain("unknown-job");
    // Should not crash — just have empty description
  });

  it("shows page title with Jobs suffix", () => {
    const args = defaultArgs();
    const html = buildJobsPage(
      args.allJobs, args.enabledJobs, args.jobAi, args.runningJobs,
      args.latestRuns, args.theme, args.paused, args.scheduleInfo,
    );
    expect(html).toContain("<title>yeti — frostyard — Jobs</title>");
  });

  it("shows logs link for jobs with latest runs", () => {
    const args = defaultArgs();
    const html = buildJobsPage(
      args.allJobs, args.enabledJobs, args.jobAi, args.runningJobs,
      args.latestRuns, args.theme, args.paused, args.scheduleInfo,
    );
    expect(html).toContain('href="/logs/run-1"');
  });

  it("shows Codex backend from JOB_AI config", () => {
    const args = defaultArgs();
    args.jobAi = { "ci-fixer": { backend: "codex" } };
    const html = buildJobsPage(
      args.allJobs, args.enabledJobs, args.jobAi, args.runningJobs,
      args.latestRuns, args.theme, args.paused, args.scheduleInfo,
    );
    expect(html).toContain("Codex");
  });

  it("renders id attributes on backend and model cells", () => {
    const args = defaultArgs();
    const html = buildJobsPage(
      args.allJobs, args.enabledJobs, args.jobAi, args.runningJobs,
      args.latestRuns, args.theme, args.paused, args.scheduleInfo,
    );
    expect(html).toContain('id="job-backend-issue-worker"');
    expect(html).toContain('id="job-model-issue-worker"');
  });

  it("shows paused status for paused jobs", () => {
    const args = defaultArgs();
    args.paused = new Set(["ci-fixer"]);
    args.runningJobs = { "issue-worker": false, "ci-fixer": false };
    const html = buildJobsPage(
      args.allJobs, args.enabledJobs, args.jobAi, args.runningJobs,
      args.latestRuns, args.theme, args.paused, args.scheduleInfo,
    );
    // Find the ci-fixer status cell
    const match = html.match(/id="job-ci-fixer"[^>]*>([^<]+)/);
    expect(match?.[1]).toBe("Paused");
  });
});
