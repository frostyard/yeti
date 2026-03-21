import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";

vi.mock("./notify.js", () => ({
  notify: vi.fn(),
}));

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
  };
});

import { notify } from "./notify.js";
import { announceIfNewVersion } from "./startup-announce.js";

describe("announceIfNewVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("notifies and writes version file when version differs from last-version", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("v2025-01-01.1");

    announceIfNewVersion("v2025-01-02.1", "/tmp/.yeti");

    expect(notify).toHaveBeenCalledWith(
      "Yeti started with updated version v2025-01-02.1",
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      "/tmp/.yeti/last-version",
      "v2025-01-02.1",
    );
  });

  it("notifies and creates version file on first run (file missing)", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    announceIfNewVersion("v2025-01-02.1", "/tmp/.yeti");

    expect(notify).toHaveBeenCalledWith(
      "Yeti started with updated version v2025-01-02.1",
    );
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      "/tmp/.yeti/last-version",
      "v2025-01-02.1",
    );
  });

  it("does not notify when version matches last-version", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("v2025-01-02.1");

    announceIfNewVersion("v2025-01-02.1", "/tmp/.yeti");

    expect(notify).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("does not notify when version is 'dev'", () => {
    announceIfNewVersion("dev", "/tmp/.yeti");

    expect(notify).not.toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("trims whitespace from stored version before comparing", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("v2025-01-02.1\n");

    announceIfNewVersion("v2025-01-02.1", "/tmp/.yeti");

    expect(notify).not.toHaveBeenCalled();
  });
});
