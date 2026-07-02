import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";

const tmpDir = vi.hoisted(() => "/tmp/yeti-quiesce-test-" + process.pid);
vi.mock("./config.js", () => ({ WORK_DIR: tmpDir }));

import { isUpdatePending, pendingUpdateTag, clearQuiesce, QUIESCE_PATH } from "./quiesce.js";

describe("quiesce sentinel", () => {
  beforeEach(() => { fs.mkdirSync(tmpDir, { recursive: true }); });
  afterEach(() => { fs.rmSync(QUIESCE_PATH, { force: true }); });

  it("reports no pending update by default", () => {
    expect(isUpdatePending()).toBe(false);
    expect(pendingUpdateTag()).toBeNull();
  });

  it("detects a sentinel and reads its tag", () => {
    fs.writeFileSync(QUIESCE_PATH, "v2026-07-02.6\n");
    expect(isUpdatePending()).toBe(true);
    expect(pendingUpdateTag()).toBe("v2026-07-02.6");
  });

  it("treats an empty sentinel as pending with no tag", () => {
    fs.writeFileSync(QUIESCE_PATH, "");
    expect(isUpdatePending()).toBe(true);
    expect(pendingUpdateTag()).toBeNull();
  });

  it("clearQuiesce removes the sentinel", () => {
    fs.writeFileSync(QUIESCE_PATH, "vX");
    clearQuiesce();
    expect(isUpdatePending()).toBe(false);
  });
});
