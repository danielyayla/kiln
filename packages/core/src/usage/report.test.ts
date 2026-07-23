import { describe, expect, it } from "vitest";
import type { ModelUsage } from "../domain";
import { DEFAULT_PRICING, pricingForModel, usageReport } from "./report";

// Fixed clock: a Saturday, mid-2026 (2026-07-11 is in ISO week 2026-W28).
const NOW = new Date("2026-07-11T12:00:00.000Z");

let seq = 0;
function entry(over: Partial<ModelUsage>): ModelUsage {
  seq += 1;
  return {
    id: `u${seq}`,
    feature: "draft",
    model: "claude-opus-4-8",
    inputTokens: 1000,
    outputTokens: 500,
    createdAt: "2026-07-11T10:00:00.000Z",
    ...over,
  };
}

describe("pricingForModel", () => {
  it("matches exact ids and dated served-model variants by prefix", () => {
    expect(pricingForModel("claude-haiku-4-5")).toEqual(DEFAULT_PRICING["claude-haiku-4-5"]);
    // the ledger stores the SERVED id, which is dated — observed live 2026-07-11
    expect(pricingForModel("claude-haiku-4-5-20251001")).toEqual(DEFAULT_PRICING["claude-haiku-4-5"]);
    expect(pricingForModel("totally-unknown-model")).toBeNull();
    // a prefix match must sit at a "-" boundary, not mid-token
    expect(pricingForModel("claude-haiku-4-55")).toBeNull();
  });
});

describe("usageReport", () => {
  it("is deterministic: fixed now + fixed entries → byte-stable output", () => {
    const entries = [
      entry({ feature: "draft" }),
      entry({ feature: "chat", model: "claude-haiku-4-5-20251001" }),
      entry({ feature: "review", model: "mystery-model" }),
    ];
    const a = JSON.stringify(usageReport(entries, { now: NOW }));
    const b = JSON.stringify(usageReport(entries, { now: NOW }));
    expect(a).toBe(b);
  });

  it("computes exact costs from the pricing table", () => {
    // 1M input + 1M output on haiku = $1 + $5
    const r = usageReport(
      [entry({ model: "claude-haiku-4-5", inputTokens: 1_000_000, outputTokens: 1_000_000 })],
      { now: NOW },
    );
    expect(r.totals.estimatedCostUsd).toBe(6);
    expect(r.costIsPartial).toBe(false);
  });

  it("buckets by day: 30 continuous buckets, oldest first, boundaries included", () => {
    const r = usageReport(
      [
        entry({ createdAt: "2026-07-11T00:00:00.000Z", inputTokens: 1, outputTokens: 0 }), // midnight today
        entry({ createdAt: "2026-06-12T23:59:59.999Z", inputTokens: 2, outputTokens: 0 }), // oldest day in window
        entry({ createdAt: "2026-06-11T12:00:00.000Z", inputTokens: 4, outputTokens: 0 }), // outside 30-day window
      ],
      { now: NOW },
    );
    expect(r.byDay).toHaveLength(30);
    expect(r.byDay[0].key).toBe("2026-06-12");
    expect(r.byDay[29].key).toBe("2026-07-11");
    expect(r.byDay[0].inputTokens).toBe(2);
    expect(r.byDay[29].inputTokens).toBe(1);
    // empty buckets exist with zeros so charts render a continuous series
    expect(r.byDay[1]).toMatchObject({ key: "2026-06-13", totalTokens: 0 });
    // out-of-window entries leave the series but stay in the totals
    expect(r.byDay.reduce((s, b) => s + b.inputTokens, 0)).toBe(3);
    expect(r.totals.inputTokens).toBe(7);
  });

  it("buckets by ISO week and by month, 12 buckets each", () => {
    const r = usageReport(
      [
        entry({ createdAt: "2026-07-06T00:00:00.000Z", inputTokens: 1, outputTokens: 0 }), // Monday of W28
        entry({ createdAt: "2026-07-05T23:59:59.999Z", inputTokens: 2, outputTokens: 0 }), // Sunday of W27
        entry({ createdAt: "2026-06-30T12:00:00.000Z", inputTokens: 4, outputTokens: 0 }), // June
      ],
      { now: NOW },
    );
    expect(r.byWeek).toHaveLength(12);
    expect(r.byWeek[11].key).toBe("2026-W28");
    expect(r.byWeek[11].inputTokens).toBe(1);
    expect(r.byWeek[10].key).toBe("2026-W27");
    expect(r.byWeek[10].inputTokens).toBe(2 + 4); // Jun 30 is also in W27

    expect(r.byMonth).toHaveLength(12);
    expect(r.byMonth[11].key).toBe("2026-07");
    expect(r.byMonth[11].inputTokens).toBe(3);
    expect(r.byMonth[10].key).toBe("2026-06");
    expect(r.byMonth[10].inputTokens).toBe(4);
    expect(r.byMonth[0].key).toBe("2025-08");
  });

  it("by-feature and by-model sums equal the totals", () => {
    const r = usageReport(
      [
        entry({ feature: "draft", model: "claude-opus-4-8", inputTokens: 10, outputTokens: 1 }),
        entry({ feature: "chat", model: "claude-haiku-4-5-20251001", inputTokens: 20, outputTokens: 2 }),
        entry({ feature: "chat", model: "claude-opus-4-8", inputTokens: 40, outputTokens: 4 }),
      ],
      { now: NOW },
    );
    const featureSum = r.byFeature.reduce((s, f) => s + f.totalTokens, 0);
    const modelSum = r.byModel.reduce((s, m) => s + m.totalTokens, 0);
    expect(featureSum).toBe(r.totals.totalTokens);
    expect(modelSum).toBe(r.totals.totalTokens);
    // every feature present in fixed order, even when unused
    expect(r.byFeature.map((f) => f.feature)).toEqual(["draft", "extract", "chat", "review", "verify"]);
    expect(r.byFeature[1].totalTokens).toBe(0); // extract unused
    // models sorted for stable output
    expect(r.byModel.map((m) => m.model)).toEqual(["claude-haiku-4-5-20251001", "claude-opus-4-8"]);
  });

  it("unknown models: tokens counted, cost null, costIsPartial set", () => {
    const r = usageReport(
      [
        entry({ model: "mystery-model", inputTokens: 1_000_000, outputTokens: 0 }),
        entry({ model: "claude-haiku-4-5", inputTokens: 1_000_000, outputTokens: 0 }),
      ],
      { now: NOW },
    );
    expect(r.costIsPartial).toBe(true);
    const mystery = r.byModel.find((m) => m.model === "mystery-model")!;
    expect(mystery.totalTokens).toBe(1_000_000);
    expect(mystery.estimatedCostUsd).toBeNull();
    // totals carry the priced part only
    expect(r.totals.estimatedCostUsd).toBe(1);
    expect(r.totals.totalTokens).toBe(2_000_000);
  });

  it("empty ledger: zero totals, no partial flag, zeroed series", () => {
    const r = usageReport([], { now: NOW });
    expect(r.totals).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 });
    expect(r.costIsPartial).toBe(false);
    expect(r.byDay.every((b) => b.totalTokens === 0)).toBe(true);
    expect(r.byModel).toEqual([]);
  });
});
