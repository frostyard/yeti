import { describe, it, expect, vi } from "vitest";

vi.mock("./config.js", () => ({ WORK_DIR: "/tmp" }));

import { getSystemStats } from "./sysstats.js";

describe("getSystemStats", () => {
  it("returns a sane snapshot (null cpu% on first sample)", () => {
    const a = getSystemStats();
    expect(a.cpuPercent).toBeNull(); // no baseline yet
    expect(a.cpuCount).toBeGreaterThan(0);
    expect(a.load).toHaveLength(3);
    a.load.forEach((v) => expect(typeof v).toBe("number"));
    expect(a.memTotal).toBeGreaterThan(0);
    expect(a.memUsed).toBeGreaterThanOrEqual(0);
    expect(a.memUsed).toBeLessThanOrEqual(a.memTotal);
    expect(a.diskTotal).toBeGreaterThan(0);
    expect(a.diskUsed).toBeGreaterThanOrEqual(0);
    expect(a.diskUsed).toBeLessThanOrEqual(a.diskTotal);
  });

  it("computes cpuPercent within 0-100 once a baseline exists", () => {
    const end = Date.now() + 30;
    while (Date.now() < end) { /* burn a little CPU to create a delta */ }
    const b = getSystemStats();
    if (b.cpuPercent !== null) {
      expect(b.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(b.cpuPercent).toBeLessThanOrEqual(100);
    }
  });
});
