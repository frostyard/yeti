import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  GITHUB_OWNERS: ["frostyard"],
}));

import { siteTitle } from "./layout.js";
import * as config from "../config.js";

describe("siteTitle", () => {
  beforeEach(() => {
    (config as { GITHUB_OWNERS: string[] }).GITHUB_OWNERS = ["frostyard"];
  });

  it("includes org name", () => {
    expect(siteTitle()).toBe("yeti — frostyard");
  });

  it("appends suffix after org", () => {
    expect(siteTitle("Queue")).toBe("yeti — frostyard — Queue");
  });

  it("returns plain yeti when no orgs configured", () => {
    (config as { GITHUB_OWNERS: string[] }).GITHUB_OWNERS = [];
    expect(siteTitle()).toBe("yeti");
  });

  it("joins multiple orgs with comma", () => {
    (config as { GITHUB_OWNERS: string[] }).GITHUB_OWNERS = ["a", "b"];
    expect(siteTitle()).toBe("yeti — a, b");
  });

  it("escapes HTML in org names", () => {
    (config as { GITHUB_OWNERS: string[] }).GITHUB_OWNERS = ["<script>"];
    expect(siteTitle()).toBe("yeti — &lt;script&gt;");
  });
});
