import { describe, it, expect } from "vitest";
import { vi } from "vitest";

const { __tier } = vi.hoisted(() => ({ __tier: {} as Record<string, string> }));
vi.mock("./config.js", () => ({
  // repoAutonomy is keyed by fullName only, matching production's fullName-keyed
  // resolution — no repo.autonomy field exists anymore.
  repoAutonomy: (r: { fullName: string }) => __tier[r.fullName] ?? "pr",
  DEFAULT_AUTONOMY: "pr",
  AUTONOMY_MAP: { "acme/advisory-repo": "advisory", "acme/merge-repo": "automerge" },
}));

import { can, assertCapability, fullNameAutonomy, tierSatisfies, AutonomyError, type Action } from "./capability.js";

const repo = (tier?: string): import("./config.js").Repo => {
  const r = { owner: "acme", name: "r", fullName: "acme/r", defaultBranch: "main" };
  if (tier) {
    __tier[r.fullName] = tier;
  } else {
    delete __tier[r.fullName];
  }
  return r as import("./config.js").Repo;
};

describe("fullNameAutonomy", () => {
  it("uses AUTONOMY_MAP when present, else DEFAULT_AUTONOMY", () => {
    expect(fullNameAutonomy("acme/advisory-repo")).toBe("advisory");
    expect(fullNameAutonomy("acme/unknown")).toBe("pr");
  });
});

describe("can", () => {
  const cases: Array<[string, Action, boolean]> = [
    ["advisory", "comment", true], ["advisory", "label", true], ["advisory", "reaction", true],
    ["advisory", "createIssue", false], ["advisory", "push", false], ["advisory", "createPR", false], ["advisory", "merge", false],
    ["issues", "createIssue", true], ["issues", "push", false], ["issues", "createPR", false], ["issues", "merge", false],
    ["pr", "createIssue", true], ["pr", "push", true], ["pr", "createPR", true], ["pr", "merge", false],
    ["automerge", "push", true], ["automerge", "createPR", true], ["automerge", "merge", true],
  ];
  for (const [tier, action, expected] of cases) {
    it(`${tier} ${expected ? "can" : "cannot"} ${action}`, () => {
      expect(can(repo(tier), action)).toBe(expected);
    });
  }
});

describe("tierSatisfies", () => {
  const cases: Array<[string, Action, boolean]> = [
    ["advisory", "comment", true],
    ["advisory", "createPR", false],
    ["issues", "createIssue", true],
    ["issues", "push", false],
    ["pr", "push", true],
    ["pr", "merge", false],
    ["automerge", "merge", true],
  ];
  for (const [tier, action, expected] of cases) {
    it(`${tier} ${expected ? "satisfies" : "does not satisfy"} ${action}`, () => {
      expect(tierSatisfies(tier as import("./policy.js").Autonomy, action)).toBe(expected);
    });
  }
});

describe("assertCapability", () => {
  it("is silent when allowed", () => {
    expect(() => assertCapability("acme/merge-repo", "merge")).not.toThrow();
  });
  it("throws AutonomyError with fields when denied", () => {
    try {
      assertCapability("acme/advisory-repo", "createPR");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AutonomyError);
      const err = e as AutonomyError;
      expect(err.fullName).toBe("acme/advisory-repo");
      expect(err.action).toBe("createPR");
      expect(err.tier).toBe("advisory");
    }
  });
});
