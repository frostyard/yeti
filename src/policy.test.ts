import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

import * as log from "./log.js";
import { substitute, resolvePolicyPath, renderPolicy, findMissingVars, countPolicyFiles, readPreamble, listLoadedPolicies } from "./policy.js";

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

  it("prepends the shared _preamble.md to every rendered prompt", () => {
    fs.writeFileSync(path.join(dir, "_preamble.md"), "ENV NOTE for ${REPO}\n");
    fs.writeFileSync(path.join(dir, "issue-worker.md"), "Fix #${NUM}");
    const out = renderPolicy("issue-worker", "pr", { NUM: "7", REPO: "acme/widget" }, { dirs: [dir] });
    expect(out).toBe("ENV NOTE for acme/widget\n\nFix #7");
  });

  it("prepends the preamble to fallback prompts too", () => {
    fs.writeFileSync(path.join(dir, "_preamble.md"), "ENV NOTE");
    const out = renderPolicy("missing", "pr", {}, { dirs: [dir], fallback: () => "FALLBACK" });
    expect(out).toBe("ENV NOTE\n\nFALLBACK");
  });

  it("readPreamble returns the trimmed preamble or empty string", () => {
    expect(readPreamble([dir])).toBe("");
    fs.writeFileSync(path.join(dir, "_preamble.md"), "ENV NOTE\n\n");
    expect(readPreamble([dir])).toBe("ENV NOTE");
  });

  it("throws when no policy file exists and no fallback is given", () => {
    expect(() => renderPolicy("missing", "pr", {}, { dirs: [dir] })).toThrow(/missing/);
  });

  it("warns via log.warn when a template has an unsubstituted var", () => {
    fs.writeFileSync(path.join(dir, "issue-worker-warn.md"), "Fix #${NUM} in ${REPO}");
    renderPolicy("issue-worker-warn", "pr", { NUM: "7" }, { dirs: [dir] }); // REPO missing
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("${REPO}"));
  });

  it("does not warn when all vars are provided", () => {
    vi.mocked(log.warn).mockClear();
    fs.writeFileSync(path.join(dir, "issue-worker-nowarn.md"), "Fix #${NUM} in ${REPO}");
    renderPolicy("issue-worker-nowarn", "pr", { NUM: "7", REPO: "acme/widget" }, { dirs: [dir] });
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("countPolicyFiles", () => {
  it("counts distinct .md files across dirs, ignoring non-md and shadowed duplicates", () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), "yeti-count-a-"));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), "yeti-count-b-"));
    fs.writeFileSync(path.join(a, "scanner.md"), "");
    fs.writeFileSync(path.join(a, "notes.txt"), "");
    fs.writeFileSync(path.join(b, "scanner.md"), ""); // shadowed by a/scanner.md
    fs.writeFileSync(path.join(b, "ci-fixer.md"), "");
    expect(countPolicyFiles([a, b])).toBe(2); // scanner + ci-fixer
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  });

  it("returns 0 for dirs that do not exist", () => {
    expect(countPolicyFiles(["/no/such/dir-xyz"])).toBe(0);
  });
});

describe("listLoadedPolicies", () => {
  let overrideDir: string;
  let bundledDir: string;

  beforeEach(() => {
    overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "yeti-loaded-override-"));
    bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), "yeti-loaded-bundled-"));
  });

  afterEach(() => {
    fs.rmSync(overrideDir, { recursive: true, force: true });
    fs.rmSync(bundledDir, { recursive: true, force: true });
  });

  it("lists distinct policies with override shadowing bundled files", () => {
    fs.writeFileSync(path.join(overrideDir, "issue-worker.md"), "");
    fs.writeFileSync(path.join(overrideDir, "_preamble.md"), "");
    fs.writeFileSync(path.join(overrideDir, "notes.txt"), "");
    fs.writeFileSync(path.join(bundledDir, "issue-worker.md"), "");
    fs.writeFileSync(path.join(bundledDir, "ci-fixer.md"), "");

    expect(listLoadedPolicies([overrideDir, bundledDir])).toEqual([
      { name: "_preamble", path: path.join(overrideDir, "_preamble.md"), source: "override" },
      { name: "ci-fixer", path: path.join(bundledDir, "ci-fixer.md"), source: "bundled" },
      { name: "issue-worker", path: path.join(overrideDir, "issue-worker.md"), source: "override" },
    ]);
  });

  it("skips missing dirs without throwing", () => {
    fs.writeFileSync(path.join(bundledDir, "ci-fixer.md"), "");

    expect(listLoadedPolicies(["/no/such/loaded-policy-dir", bundledDir])).toEqual([
      { name: "ci-fixer", path: path.join(bundledDir, "ci-fixer.md"), source: "bundled" },
    ]);
  });
});
