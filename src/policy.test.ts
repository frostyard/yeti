import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { substitute, resolvePolicyPath, renderPolicy, findMissingVars } from "./policy.js";

describe("substitute", () => {
  it("replaces ${VAR} placeholders with their values", () => {
    const out = substitute("Hello ${NAME}, issue #${NUM}", { NAME: "world", NUM: "42" });
    expect(out).toBe("Hello world, issue #42");
  });

  it("leaves unknown ${VAR} placeholders intact so typos are visible", () => {
    const out = substitute("known=${A} unknown=${B}", { A: "1" });
    expect(out).toBe("known=1 unknown=${B}");
  });

  it("treats a value containing ${...} literally (no re-injection)", () => {
    const out = substitute("body=${BODY}", { BODY: "see ${NAME}", NAME: "SHOULD_NOT_APPEAR" });
    expect(out).toBe("body=see ${NAME}");
  });

  it("treats a value's bare $ literally", () => {
    const out = substitute("cost=${C}", { C: "$5 and $$" });
    expect(out).toBe("cost=$5 and $$");
  });
});

describe("findMissingVars", () => {
  it("returns template placeholders not present in vars, distinct and in order", () => {
    expect(findMissingVars("${A} ${B} ${A} ${C}", { A: "1" })).toEqual(["B", "C"]);
  });

  it("returns [] when every placeholder is provided", () => {
    expect(findMissingVars("${A}-${B}", { A: "1", B: "2" })).toEqual([]);
  });

  it("does not flag ${...} that appears only inside a provided value", () => {
    // BODY is provided, so even though its value contains ${X}, X is not a template placeholder
    expect(findMissingVars("body=${BODY}", { BODY: "see ${X}" })).toEqual([]);
  });
});

describe("resolvePolicyPath", () => {
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), "yeti-policy-a-"));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), "yeti-policy-b-"));
  });

  afterEach(() => {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  });

  it("returns null when no policy file exists in any dir", () => {
    expect(resolvePolicyPath("scanner", "pr", [dirA, dirB])).toBeNull();
  });

  it("prefers the autonomy-suffixed variant over the base within a dir", () => {
    fs.writeFileSync(path.join(dirA, "scanner.md"), "base");
    fs.writeFileSync(path.join(dirA, "scanner-advisory.md"), "advisory");
    expect(resolvePolicyPath("scanner", "advisory", [dirA])).toBe(
      path.join(dirA, "scanner-advisory.md"),
    );
  });

  it("prefers an earlier dir (override) over a later dir (bundled)", () => {
    fs.writeFileSync(path.join(dirB, "scanner.md"), "bundled");
    fs.writeFileSync(path.join(dirA, "scanner.md"), "override");
    expect(resolvePolicyPath("scanner", "pr", [dirA, dirB])).toBe(
      path.join(dirA, "scanner.md"),
    );
  });

  it("falls back to the base file when the suffixed variant is absent", () => {
    fs.writeFileSync(path.join(dirA, "scanner.md"), "base");
    expect(resolvePolicyPath("scanner", "automerge", [dirA])).toBe(
      path.join(dirA, "scanner.md"),
    );
  });

  it("maps each autonomy tier to its expected suffix", () => {
    fs.writeFileSync(path.join(dirA, "s-advisory.md"), "");
    fs.writeFileSync(path.join(dirA, "s-issues.md"), "");
    fs.writeFileSync(path.join(dirA, "s-full.md"), "");
    fs.writeFileSync(path.join(dirA, "s-automerge.md"), "");
    expect(resolvePolicyPath("s", "advisory", [dirA])).toBe(path.join(dirA, "s-advisory.md"));
    expect(resolvePolicyPath("s", "issues", [dirA])).toBe(path.join(dirA, "s-issues.md"));
    expect(resolvePolicyPath("s", "pr", [dirA])).toBe(path.join(dirA, "s-full.md"));
    expect(resolvePolicyPath("s", "automerge", [dirA])).toBe(path.join(dirA, "s-automerge.md"));
  });

  it("resolves a dotted variant name with the autonomy suffix", () => {
    fs.writeFileSync(path.join(dirA, "issue-worker.phased.md"), "base");
    fs.writeFileSync(path.join(dirA, "issue-worker.phased-full.md"), "full");
    expect(resolvePolicyPath("issue-worker.phased", "pr", [dirA])).toBe(
      path.join(dirA, "issue-worker.phased-full.md"),
    );
  });

  it("falls back to the dotted base when the suffixed variant is absent", () => {
    fs.writeFileSync(path.join(dirA, "issue-worker.phased.md"), "base");
    expect(resolvePolicyPath("issue-worker.phased", "advisory", [dirA])).toBe(
      path.join(dirA, "issue-worker.phased.md"),
    );
  });
});

describe("renderPolicy", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "yeti-policy-r-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("loads a policy file and substitutes its placeholders", () => {
    fs.writeFileSync(path.join(dir, "issue-worker.md"), "Fix #${NUM} in ${REPO}");
    const out = renderPolicy(
      "issue-worker",
      "pr",
      { NUM: "7", REPO: "acme/widget" },
      { dirs: [dir] },
    );
    expect(out).toBe("Fix #7 in acme/widget");
  });

  it("uses the fallback when no policy file exists", () => {
    const out = renderPolicy("missing", "pr", {}, { dirs: [dir], fallback: () => "FALLBACK" });
    expect(out).toBe("FALLBACK");
  });

  it("throws when no policy file exists and no fallback is given", () => {
    expect(() => renderPolicy("missing", "pr", {}, { dirs: [dir] })).toThrow(/missing/);
  });
});
