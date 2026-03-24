import { describe, it, expect, vi, beforeEach } from "vitest";

let mockLogLevel = "debug";

vi.mock("./config.js", () => ({
  get LOG_LEVEL() { return mockLogLevel; },
}));

vi.mock("./notify.js", () => ({
  notify: vi.fn(),
}));

vi.mock("./db.js", () => ({
  insertJobLog: vi.fn(),
}));

import { debug, info, warn, error, runContext } from "./log.js";
import { insertJobLog } from "./db.js";
import { notify } from "./notify.js";

beforeEach(() => {
  mockLogLevel = "debug";
  vi.clearAllMocks();
});

describe("log level gating", () => {
  it("logs all levels when LOG_LEVEL is debug", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    debug("d");
    info("i");
    warn("w");
    error("e");

    expect(logSpy).toHaveBeenCalledTimes(2); // debug + info
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("suppresses debug and info when LOG_LEVEL is warn", () => {
    mockLogLevel = "warn";

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    debug("d");
    info("i");
    warn("w");
    error("e");

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("suppresses debug, info, and warn when LOG_LEVEL is error", () => {
    mockLogLevel = "error";

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    debug("d");
    info("i");
    warn("w");
    error("e");

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("error always logs and notifies regardless of level", () => {
    mockLogLevel = "error";

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    error("critical");

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("[ERROR] critical");

    errorSpy.mockRestore();
  });

  it("suppressed levels do not capture to DB", () => {
    mockLogLevel = "warn";

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    runContext.run({ runId: "test-run" }, () => {
      debug("d");
      info("i");
      warn("w");
      error("e");
    });

    // Only warn and error should have been captured
    expect(insertJobLog).toHaveBeenCalledTimes(2);
    expect(insertJobLog).toHaveBeenCalledWith("test-run", "warn", "w");
    expect(insertJobLog).toHaveBeenCalledWith("test-run", "error", "e");

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("changing LOG_LEVEL at runtime changes gating behavior (live reload)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Start at warn — debug should be suppressed
    mockLogLevel = "warn";
    debug("suppressed");
    expect(logSpy).not.toHaveBeenCalled();

    // Switch to debug — now it should log
    mockLogLevel = "debug";
    debug("visible");
    expect(logSpy).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("only suppresses debug when LOG_LEVEL is info", () => {
    mockLogLevel = "info";

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    debug("d");
    info("i");
    warn("w");
    error("e");

    // debug suppressed, info goes through console.log
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
