import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  GITHUB_OWNERS: ["frostyard"],
}));

import { buildReposPage, type ReposPageData } from "./repos.js";
import type { Repo } from "../config.js";
import type { QueueItem } from "../github.js";
import type { Task } from "../db.js";

function mockRepo(name: string, owner = "frostyard"): Repo {
  return { owner, name, fullName: `${owner}/${name}`, defaultBranch: "main" };
}

function mockQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    repo: "frostyard/yeti",
    number: 42,
    title: "Test issue",
    category: "refined",
    updatedAt: "2025-01-01T00:00:00Z",
    type: "issue",
    ...overrides,
  };
}

function mockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    job_name: "issue-worker",
    repo: "frostyard/yeti",
    item_number: 10,
    trigger_label: null,
    worktree_path: null,
    branch_name: null,
    run_id: null,
    status: "completed",
    error: null,
    started_at: "2025-01-01 00:00:00",
    completed_at: "2025-01-01 00:01:00",
    ...overrides,
  };
}

function defaultData(overrides: Partial<ReposPageData> = {}): ReposPageData {
  return {
    repos: [mockRepo("yeti"), mockRepo("frost")],
    queueItems: [],
    recentTasks: [],
    availableRepos: [],
    allowedReposIsNull: false,
    theme: "dark",
    ...overrides,
  };
}

describe("buildReposPage", () => {
  it("renders summary counts", () => {
    const html = buildReposPage(defaultData());
    expect(html).toContain("Configured Repos");
    expect(html).toContain("<dd>2</dd>");
    expect(html).toContain("Active Repos");
    expect(html).toContain("<dd>0</dd>");
  });

  it("renders repo sections for each configured repo", () => {
    const html = buildReposPage(defaultData());
    expect(html).toContain("frostyard/yeti");
    expect(html).toContain("frostyard/frost");
  });

  it("groups active queue items by repo", () => {
    const data = defaultData({
      queueItems: [
        mockQueueItem({ repo: "frostyard/yeti", number: 1, title: "Fix bug" }),
        mockQueueItem({ repo: "frostyard/yeti", number: 2, title: "Add feature", type: "pr", prNumber: 5 }),
      ],
    });
    const html = buildReposPage(data);
    expect(html).toContain("Fix bug");
    expect(html).toContain("Add feature");
    expect(html).toContain("#1");
    expect(html).toContain("#5");
    // Active repos count should be 1
    expect(html).toContain("<dd>1</dd>");
  });

  it("shows recently completed tasks", () => {
    const data = defaultData({
      recentTasks: [
        mockTask({ repo: "frostyard/yeti", item_number: 10 }),
      ],
    });
    const html = buildReposPage(data);
    expect(html).toContain("Recently Completed");
    expect(html).toContain("#10");
  });

  it("shows no active items message for empty repos", () => {
    const html = buildReposPage(defaultData());
    expect(html).toContain("No active items");
  });

  it("shows Add Repo dialog when available repos exist", () => {
    const data = defaultData({
      availableRepos: [mockRepo("new-repo")],
    });
    const html = buildReposPage(data);
    expect(html).toContain("Add Repo");
    expect(html).toContain("add-repo-dialog");
    expect(html).toContain("frostyard/new-repo");
  });

  it("shows disabled add button when no repos available", () => {
    const data = defaultData({ availableRepos: [] });
    const html = buildReposPage(data);
    expect(html).toContain("none available");
  });

  it("shows note when allowedRepos is null", () => {
    const data = defaultData({ allowedReposIsNull: true });
    const html = buildReposPage(data);
    expect(html).toContain("All org repos are included");
  });

  it("escapes HTML in titles", () => {
    const data = defaultData({
      queueItems: [
        mockQueueItem({ title: "<script>alert(1)</script>" }),
      ],
    });
    const html = buildReposPage(data);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders GitHub links for repos", () => {
    const html = buildReposPage(defaultData());
    expect(html).toContain("https://github.com/frostyard/yeti/issues");
    expect(html).toContain("https://github.com/frostyard/yeti/pulls");
  });

  it("shows check status badges for PRs", () => {
    const data = defaultData({
      queueItems: [
        mockQueueItem({ type: "pr", prNumber: 5, checkStatus: "passing" }),
      ],
    });
    const html = buildReposPage(data);
    expect(html).toContain("check-pass");
  });

  it("renders page title with Repos suffix", () => {
    const html = buildReposPage(defaultData());
    expect(html).toContain("<title>yeti — frostyard — Repos</title>");
  });

  it("includes category badge for queue items", () => {
    const data = defaultData({
      queueItems: [
        mockQueueItem({ category: "needs-refinement" }),
      ],
    });
    const html = buildReposPage(data);
    expect(html).toContain("Needs Refinement");
  });
});
