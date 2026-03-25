import { describe, it, expect } from "vitest";
import { buildNotificationsPage } from "./notifications.js";

describe("buildNotificationsPage", () => {
  it("renders empty state", () => {
    const html = buildNotificationsPage([], "system");
    expect(html).toContain("No notifications");
  });

  it("renders notification rows", () => {
    const notifications = [
      { id: 2, job_name: "issue-worker", message: "Created PR #5", url: "https://github.com/org/repo/pull/5", level: "info", created_at: "2026-03-24 14:30:00" },
      { id: 1, job_name: "system", message: "Rate limit hit", url: null, level: "warn", created_at: "2026-03-24 14:00:00" },
    ];
    const html = buildNotificationsPage(notifications, "light");
    expect(html).toContain("issue-worker");
    expect(html).toContain("Created PR #5");
    expect(html).toContain("https://github.com/org/repo/pull/5");
    expect(html).toContain("Rate limit hit");
    expect(html).toContain("Notifications");
  });

  it("includes level as CSS class for styling", () => {
    const notifications = [
      { id: 1, job_name: "system", message: "Error!", url: null, level: "error", created_at: "2026-03-24 14:00:00" },
    ];
    const html = buildNotificationsPage(notifications, "system");
    expect(html).toContain("level-error");
  });
});
