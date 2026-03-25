import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./discord.js", () => ({
  notify: vi.fn(),
}));

vi.mock("./db.js", () => ({
  insertNotification: vi.fn().mockReturnValue({
    id: 1,
    job_name: "test-job",
    message: "test",
    url: null,
    level: "info",
    created_at: "2026-01-01 00:00:00",
  }),
}));

import { notify, notificationEmitter } from "./notify.js";
import { notify as discordNotify } from "./discord.js";
import { insertNotification } from "./db.js";

describe("notify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("inserts into DB and forwards to discord", () => {
    notify({ jobName: "issue-worker", message: "Created PR #5", url: "https://github.com/org/repo/pull/5" });
    expect(insertNotification).toHaveBeenCalledWith("issue-worker", "Created PR #5", "https://github.com/org/repo/pull/5", "info");
    expect(discordNotify).toHaveBeenCalledWith("[issue-worker] Created PR #5\nhttps://github.com/org/repo/pull/5");
  });

  it("omits url line from discord when url is undefined", () => {
    notify({ jobName: "system", message: "Rate limit hit" });
    expect(discordNotify).toHaveBeenCalledWith("[system] Rate limit hit");
  });

  it("defaults level to info", () => {
    notify({ jobName: "system", message: "test" });
    expect(insertNotification).toHaveBeenCalledWith("system", "test", undefined, "info");
  });

  it("passes explicit level", () => {
    notify({ jobName: "system", message: "error!", level: "error" });
    expect(insertNotification).toHaveBeenCalledWith("system", "error!", undefined, "error");
  });

  it("emits notification event", () => {
    const handler = vi.fn();
    notificationEmitter.on("notification", handler);
    notify({ jobName: "test", message: "hello" });
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ job_name: "test-job" }));
    notificationEmitter.off("notification", handler);
  });

  it("still forwards to discord if DB insert throws", () => {
    vi.mocked(insertNotification).mockImplementationOnce(() => { throw new Error("DB fail"); });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    notify({ jobName: "test", message: "hello" });
    expect(discordNotify).toHaveBeenCalledWith("[test] hello");
    stderrSpy.mockRestore();
  });
});
