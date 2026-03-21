import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./discord.js", () => ({
  notify: vi.fn(),
}));

import { notify } from "./notify.js";
import { notify as discordNotify } from "./discord.js";

describe("notify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards to discord", () => {
    notify("test message");
    expect(discordNotify).toHaveBeenCalledWith("test message");
  });
});
