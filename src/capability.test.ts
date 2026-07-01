import { describe, it, expect } from "vitest";
import { vi } from "vitest";

vi.mock("./config.js", () => ({
  // repoAutonomy honors an explicit repo.autonomy for the pre-flight `can` tests
  repoAutonomy: (r: { autonomy?: string }) => r?.autonomy ?? "pr",
  DEFAULT_AUTONOMY: "pr",
  AUTONOMY_MAP: { "acme/advisory-repo": "advisory", "acme/merge-repo": "automerge" },
}));

import { can, assertCapability, fullNameAutonomy, AutonomyError, type Action } from "./capability.js";

const repo = (autonomy?: string) => ({ owner: "acme", name: "r", fullName: "acme/r", defaultBranch: "main", ...(autonomy ? { autonomy } : {}) }) as unknown as import("./config.js").Repo;

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
