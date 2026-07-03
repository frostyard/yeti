import { describe, it, expect, vi } from "vitest";

vi.mock("./github.js", () => ({
  isYetiComment: (body: string) => body.includes("<!-- yeti-automated -->"),
}));

import {
  REVIEW_HEADER,
  reviewMarker,
  findReviewOfPlanVersion,
  parseVerdict,
  countBlockingFindings,
  renderVerdict,
  countPlanRounds,
  countSegments,
} from "./review-contract.js";

const YETI = "<!-- yeti-automated -->";

function comment(over: Partial<{ id: number; body: string; login: string; updatedAt: string }> = {}) {
  return { id: 1, body: "hi", login: "alice", updatedAt: "", ...over };
}

describe("reviewMarker", () => {
  it("encodes plan comment id and updatedAt", () => {
    expect(reviewMarker(501, "2026-07-01T10:00:00Z")).toBe(
      "<!-- yeti-review-of:501:2026-07-01T10:00:00Z -->",
    );
  });
});

describe("findReviewOfPlanVersion", () => {
  const marker = reviewMarker(501, "2026-07-01T10:00:00Z");

  it("finds a yeti review carrying the marker for the exact plan version", () => {
    const review = comment({ id: 601, body: `${YETI}## Plan Review\n\nFindings\n\n${marker}`, login: "yeti[bot]" });
    expect(findReviewOfPlanVersion([comment(), review], 501, "2026-07-01T10:00:00Z")).toBe(review);
  });

  it("returns undefined when the plan was edited after the review (updatedAt mismatch)", () => {
    const review = comment({ id: 601, body: `${YETI}## Plan Review\n\n${marker}` });
    expect(findReviewOfPlanVersion([review], 501, "2026-07-02T09:00:00Z")).toBeUndefined();
  });

  it("ignores marker text in non-yeti comments", () => {
    const spoof = comment({ id: 602, body: `## Plan Review\n${marker}` });
    expect(findReviewOfPlanVersion([spoof], 501, "2026-07-01T10:00:00Z")).toBeUndefined();
  });
});

describe("parseVerdict", () => {
  it("parses APPROVED", () => {
    expect(parseVerdict("All good.\nVERDICT: APPROVED")).toBe("approved");
  });

  it("parses NEEDS REVISION case-insensitively", () => {
    expect(parseVerdict("Problems.\nverdict: needs revision")).toBe("needs-revision");
  });

  it("parses verdicts with trailing terminal punctuation", () => {
    expect(parseVerdict("All good.\nVERDICT: APPROVED.")).toBe("approved");
    expect(parseVerdict("Problems remain.\nVERDICT: NEEDS REVISION?")).toBe("needs-revision");
  });

  it("uses the last verdict line", () => {
    expect(parseVerdict("VERDICT: APPROVED\n...\nVERDICT: NEEDS REVISION")).toBe("needs-revision");
  });

  it("returns missing when no verdict line exists", () => {
    expect(parseVerdict("A review with no conclusion.")).toBe("missing");
  });
});

describe("countBlockingFindings", () => {
  it("counts bracketed blocking finding IDs, not advisories or prior-finding mentions", () => {
    const review = [
      "### Prior findings",
      "- R1-B1: resolved",
      "### Blocking",
      "- [R2-B1] cleanup skipped (updex/install.go:36)",
      "- [R2-B2] wrong default path",
      "### Advisory",
      "- [R2-A1] add a test",
    ].join("\n");
    expect(countBlockingFindings(review)).toBe(2);
  });

  it("returns 0 when there are no blocking findings", () => {
    expect(countBlockingFindings("### Advisory\n- [R1-A1] nit")).toBe(0);
  });

  it("ignores bracketed blocking finding IDs outside the Blocking section", () => {
    const review = [
      "### Prior findings",
      "- [R1-B1] resolved by the updated plan",
      "### Blocking",
      "- [R2-B1] current issue",
      "### Advisory",
      "- [R2-B2] incorrectly bracketed reference, but not in Blocking",
    ].join("\n");
    expect(countBlockingFindings(review)).toBe(1);
  });

  it("counts segment-prefixed blocking finding IDs", () => {
    const review = [
      "### Blocking",
      "- [S2-R1-B1] reset-segment defect",
      "- [S2-R1-B2] another reset-segment defect",
      "### Advisory",
      "- [S2-R1-A1] suggestion",
    ].join("\n");
    expect(countBlockingFindings(review)).toBe(2);
  });

  it("counts mixed segment-prefixed and unprefixed blocking finding IDs", () => {
    const review = [
      "### Blocking",
      "- [R1-B1] original-segment defect",
      "- [S2-R1-B1] reset-segment defect",
    ].join("\n");
    expect(countBlockingFindings(review)).toBe(2);
  });
});

describe("renderVerdict", () => {
  it("replaces the verdict line with a bold human-readable form including blocking count", () => {
    const out = renderVerdict("### Blocking\n- [R1-B1] bad\n\nVERDICT: NEEDS REVISION", "needs-revision");
    expect(out).toContain("**Verdict: NEEDS REVISION** (1 blocking)");
    expect(out).not.toMatch(/^VERDICT:/m);
  });

  it("renders APPROVED without a count", () => {
    const out = renderVerdict("Looks solid.\nVERDICT: APPROVED", "approved");
    expect(out).toContain("**Verdict: APPROVED**");
  });

  it("uses the computed verdict over the declared verdict", () => {
    const out = renderVerdict("### Blocking\n- [R1-B1] bad\n\nVERDICT: APPROVED", "needs-revision");
    expect(out).toContain("**Verdict: NEEDS REVISION** (1 blocking)");
    expect(out).not.toContain("**Verdict: APPROVED**");
  });

  it("appends the computed verdict when the raw verdict line is missing", () => {
    expect(renderVerdict("no verdict here", "approved")).toBe("no verdict here\n\n**Verdict: APPROVED**");
  });
});

describe("countPlanRounds", () => {
  const review = (id: number) => comment({ id, body: `${YETI}## Plan Review\n\nstuff`, login: "yeti[bot]" });
  const human = (id: number) => comment({ id, body: "please change X", login: "bsherman" });
  const bot = (id: number) => comment({ id, body: "coverage report", login: "codecov[bot]" });

  it("counts all yeti reviews when no human has commented", () => {
    expect(countPlanRounds([review(1), review(2)])).toBe(2);
  });

  it("resets the count after the most recent human comment", () => {
    expect(countPlanRounds([review(1), review(2), human(3), review(4)])).toBe(1);
  });

  it("does not treat [bot] comments as human", () => {
    expect(countPlanRounds([review(1), bot(2), review(3)])).toBe(2);
  });
});

describe("countSegments", () => {
  const review = (id: number) => comment({ id, body: `${YETI}## Plan Review\n\nstuff`, login: "yeti[bot]" });
  const human = (id: number) => comment({ id, body: "please change X", login: "bsherman" });
  const bot = (id: number) => comment({ id, body: "coverage report", login: "codecov[bot]" });

  it("returns segment 1 when no human has commented", () => {
    expect(countSegments([review(1), review(2)])).toBe(1);
  });

  it("increments after a human comment", () => {
    expect(countSegments([review(1), human(2), review(3)])).toBe(2);
  });

  it("does not treat [bot] comments as human", () => {
    expect(countSegments([review(1), bot(2), review(3)])).toBe(1);
  });
});
