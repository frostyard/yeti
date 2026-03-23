import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  GITHUB_OWNERS: ["frostyard"],
}));

import { siteTitle, buildNav } from "./layout.js";
import * as config from "../config.js";

describe("siteTitle", () => {
  beforeEach(() => {
    (config as { GITHUB_OWNERS: readonly string[] }).GITHUB_OWNERS = ["frostyard"];
  });

  it("includes org name", () => {
    expect(siteTitle()).toBe("yeti — frostyard");
  });

  it("appends suffix after org", () => {
    expect(siteTitle("Queue")).toBe("yeti — frostyard — Queue");
  });

  it("returns plain yeti when no orgs configured", () => {
    (config as { GITHUB_OWNERS: readonly string[] }).GITHUB_OWNERS = [];
    expect(siteTitle()).toBe("yeti");
  });

  it("joins multiple orgs with comma", () => {
    (config as { GITHUB_OWNERS: readonly string[] }).GITHUB_OWNERS = ["a", "b"];
    expect(siteTitle()).toBe("yeti — a, b");
  });

  it("escapes HTML in org names", () => {
    (config as { GITHUB_OWNERS: readonly string[] }).GITHUB_OWNERS = ["<script>"];
    expect(siteTitle()).toBe("yeti — &lt;script&gt;");
  });
});

describe("buildNav", () => {
  it("includes all navigation links in order", () => {
    const nav = buildNav("system");
    expect(nav).toContain('href="/"');
    expect(nav).toContain('href="/jobs"');
    expect(nav).toContain('href="/queue"');
    expect(nav).toContain('href="/logs"');
    expect(nav).toContain('href="/config"');
    // Jobs should come before Queue
    const jobsPos = nav.indexOf("/jobs");
    const queuePos = nav.indexOf("/queue");
    expect(jobsPos).toBeLessThan(queuePos);
  });
});
