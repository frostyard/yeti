import { describe, it, expect } from "vitest";
import { formatUptime, formatCountdown, formatRelativeTime, repoShortName, formatDuration } from "./format";

describe("format helpers", () => {
  it("formatUptime", () => {
    expect(formatUptime(0)).toBe("0s");
    expect(formatUptime(90)).toBe("1m 30s");
    expect(formatUptime(90061)).toBe("1d 1h 1m 1s");
  });

  it("formatCountdown", () => {
    expect(formatCountdown(0)).toBe("soon");
    expect(formatCountdown(45_000)).toBe("in 45s");
    expect(formatCountdown(90_000)).toBe("in 1m");
    expect(formatCountdown(3_660_000)).toBe("in 1h 1m");
  });

  it("formatRelativeTime uses provided now and handles UTC sql timestamps", () => {
    const now = Date.parse("2025-01-01T00:05:00Z");
    expect(formatRelativeTime("2025-01-01 00:00:00", now)).toBe("5m ago");
    expect(formatRelativeTime("", now)).toBe("");
  });

  it("formatDuration", () => {
    expect(formatDuration("2025-01-01 00:00:00", "2025-01-01 00:01:30")).toBe("1m 30s");
    expect(formatDuration("2025-01-01 00:00:00", null)).toBe("—");
  });

  it("repoShortName", () => {
    expect(repoShortName("owner/repo")).toBe("repo");
    expect(repoShortName("repo")).toBe("repo");
  });
});
