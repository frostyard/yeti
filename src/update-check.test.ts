import { beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    writeFileSync: fsMocks.writeFileSync,
  },
  writeFileSync: fsMocks.writeFileSync,
}));

vi.mock("./config.js", () => ({
  WORK_DIR: "/tmp/yeti",
}));

import { requestUpdateCheck, UPDATE_CHECK_PATH } from "./update-check.js";

describe("requestUpdateCheck", () => {
  beforeEach(() => {
    fsMocks.writeFileSync.mockClear();
  });

  it("touches the update-check sentinel", () => {
    requestUpdateCheck();

    expect(UPDATE_CHECK_PATH).toBe("/tmp/yeti/update-check-requested");
    expect(fsMocks.writeFileSync).toHaveBeenCalledWith(
      "/tmp/yeti/update-check-requested",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z\n$/),
    );
  });

  it("is safe to call repeatedly", () => {
    requestUpdateCheck();
    requestUpdateCheck();

    expect(fsMocks.writeFileSync).toHaveBeenCalledTimes(2);
    expect(fsMocks.writeFileSync.mock.calls.map(call => call[0])).toEqual([
      "/tmp/yeti/update-check-requested",
      "/tmp/yeti/update-check-requested",
    ]);
  });
});
