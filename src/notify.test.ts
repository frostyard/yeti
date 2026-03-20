import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./slack.js", () => ({
  notify: vi.fn(),
}));

import { notify } from "./notify.js";
import { notify as slackNotify } from "./slack.js";

describe("notify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards to slack", () => {
    notify("test message");
    expect(slackNotify).toHaveBeenCalledWith("test message");
  });
});
