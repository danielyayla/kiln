import { describe, expect, it } from "vitest";
import type { VerificationReceipt } from "@kiln/core";
import { isCleanPass, latestReceipt, summarizeVerdict, verdictCounts } from "./verification";

const receipt = (over: Partial<VerificationReceipt>): VerificationReceipt => ({
  id: "vr-1",
  workOrderId: "wo-1",
  criteria: [],
  overall: "met",
  createdAt: "2026-07-23T10:00:00.000Z",
  ...over,
});

const criterion = (status: "met" | "unmet" | "undecidable") => ({
  criterion: "does the thing",
  status,
  reason: "because the receipt says so",
});

describe("latestReceipt", () => {
  it("returns null for none and the last (newest) of many", () => {
    expect(latestReceipt([])).toBeNull();
    const a = receipt({ id: "a" });
    const b = receipt({ id: "b" });
    expect(latestReceipt([a, b])?.id).toBe("b");
  });
});

describe("isCleanPass", () => {
  it("requires overall met AND every criterion met", () => {
    expect(isCleanPass(receipt({ overall: "met", criteria: [criterion("met")] }))).toBe(true);
    expect(isCleanPass(receipt({ overall: "met", criteria: [criterion("met"), criterion("undecidable")] }))).toBe(false);
    expect(isCleanPass(receipt({ overall: "unmet", criteria: [criterion("met")] }))).toBe(false);
    // No criteria at all: overall met alone counts as clean (vacuous every()).
    expect(isCleanPass(receipt({ overall: "met" }))).toBe(true);
  });
});

describe("verdict summaries", () => {
  it("counts per status and renders only non-zero parts", () => {
    const r = receipt({ criteria: [criterion("met"), criterion("met"), criterion("undecidable")] });
    expect(verdictCounts(r)).toEqual({ met: 2, unmet: 0, undecidable: 1 });
    expect(summarizeVerdict(r)).toBe("2 met · 1 undecidable");
  });

  it("falls back to the overall verdict when there are no criteria", () => {
    expect(summarizeVerdict(receipt({ overall: "undecidable" }))).toBe("no criteria — overall undecidable");
  });
});
