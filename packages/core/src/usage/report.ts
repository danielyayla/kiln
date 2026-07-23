import { MODEL_USAGE_FEATURES, type ModelUsage, type ModelUsageFeature } from "../domain";

// Pure usage aggregation (AI settings & usage): totals, time-bucketed series,
// and by-feature / by-model breakdowns over the model-call ledger. No Store
// import, no clock — the caller supplies entries and `now` — so output is a
// deterministic function of its inputs (same rationale as graph/pulse.ts).

export interface ModelPricing {
  inputPerMTok: number; // USD per million input tokens
  outputPerMTok: number; // USD per million output tokens
}

// Published Anthropic per-MTok pricing, verified against the claude-api
// reference on 2026-07-11 (pricing table cached 2026-06-24). These figures
// make cost an ESTIMATE, never an invoice: unknown model ids contribute null
// cost and flip `costIsPartial` instead of guessing.
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-mythos-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

// The ledger stores the SERVED model id, which the API resolves to a dated
// variant (e.g. "claude-haiku-4-5-20251001") — so an exact-key lookup would
// miss every real entry. Exact match first, then the longest pricing key that
// prefixes the id at a "-" boundary.
export function pricingForModel(
  model: string,
  pricing: Record<string, ModelPricing> = DEFAULT_PRICING,
): ModelPricing | null {
  if (pricing[model]) return pricing[model];
  let best: string | null = null;
  for (const key of Object.keys(pricing)) {
    if (model.startsWith(`${key}-`) && (best === null || key.length > best.length)) best = key;
  }
  return best ? pricing[best] : null;
}

export interface UsageBucket {
  key: string; // "2026-07-11" | "2026-W28" | "2026-07"
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null; // null = tokens present but none priceable
}

export interface UsageBreakdownRow {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
}

export interface UsageReport {
  totals: UsageBreakdownRow;
  // True when at least one entry's model has no pricing — the cost figures
  // then cover only the priceable part of the ledger.
  costIsPartial: boolean;
  byDay: UsageBucket[]; // last 30 days, oldest first, empty buckets zeroed
  byWeek: UsageBucket[]; // last 12 ISO weeks
  byMonth: UsageBucket[]; // last 12 months
  byFeature: ({ feature: ModelUsageFeature } & UsageBreakdownRow)[]; // every feature, fixed order
  byModel: ({ model: string } & UsageBreakdownRow)[]; // models present, sorted
}

export interface UsageReportOptions {
  now: Date;
  pricing?: Record<string, ModelPricing>;
}

const DAY_MS = 86_400_000;

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

// ISO-8601 week (UTC): the week containing the date's Thursday, "YYYY-Www".
function weekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const week = Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / DAY_MS + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

// Cents-level float noise (0.30000000000000004) would make output order- and
// grouping-sensitive; fixing 6 decimals keeps the report byte-stable.
function roundUsd(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

interface Acc {
  inputTokens: number;
  outputTokens: number;
  cost: number; // priced entries only
  priced: number; // how many entries were priceable
  count: number;
}

function newAcc(): Acc {
  return { inputTokens: 0, outputTokens: 0, cost: 0, priced: 0, count: 0 };
}

function addTo(acc: Acc, e: ModelUsage, price: ModelPricing | null): void {
  acc.inputTokens += e.inputTokens;
  acc.outputTokens += e.outputTokens;
  acc.count += 1;
  if (price) {
    acc.cost += (e.inputTokens * price.inputPerMTok + e.outputTokens * price.outputPerMTok) / 1e6;
    acc.priced += 1;
  }
}

// A group with tokens but zero priceable entries reads null (unknown), not $0
// (which would claim "free"). Mixed groups report the priced part; the
// top-level costIsPartial flags the gap.
function rowOf(acc: Acc): UsageBreakdownRow {
  return {
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    totalTokens: acc.inputTokens + acc.outputTokens,
    estimatedCostUsd: acc.count > 0 && acc.priced === 0 ? null : roundUsd(acc.cost),
  };
}

export function usageReport(entries: ModelUsage[], opts: UsageReportOptions): UsageReport {
  const pricing = opts.pricing ?? DEFAULT_PRICING;
  const now = opts.now;

  const totals = newAcc();
  const byFeature = new Map<ModelUsageFeature, Acc>(MODEL_USAGE_FEATURES.map((f) => [f, newAcc()]));
  const byModel = new Map<string, Acc>();
  const byKey = { day: new Map<string, Acc>(), week: new Map<string, Acc>(), month: new Map<string, Acc>() };

  for (const e of entries) {
    const price = pricingForModel(e.model, pricing);
    const at = new Date(e.createdAt);
    addTo(totals, e, price);
    addTo(byFeature.get(e.feature) ?? byFeature.set(e.feature, newAcc()).get(e.feature)!, e, price);
    if (!byModel.has(e.model)) byModel.set(e.model, newAcc());
    addTo(byModel.get(e.model)!, e, price);
    for (const [granularity, keyOf] of [
      ["day", dayKey],
      ["week", weekKey],
      ["month", monthKey],
    ] as const) {
      const key = keyOf(at);
      const map = byKey[granularity];
      if (!map.has(key)) map.set(key, newAcc());
      addTo(map.get(key)!, e, price);
    }
  }

  // Continuous series ending at `now`, empty buckets zeroed. Entries older
  // than a series' window drop out of that series but stay in the totals.
  const series = (count: number, dateAt: (i: number) => Date, keyOf: (d: Date) => string, map: Map<string, Acc>) =>
    Array.from({ length: count }, (_, idx) => {
      const key = keyOf(dateAt(count - 1 - idx)); // oldest first
      return { key, ...rowOf(map.get(key) ?? newAcc()) };
    });

  return {
    totals: rowOf(totals),
    costIsPartial: totals.priced < totals.count,
    byDay: series(30, (i) => new Date(now.getTime() - i * DAY_MS), dayKey, byKey.day),
    byWeek: series(12, (i) => new Date(now.getTime() - i * 7 * DAY_MS), weekKey, byKey.week),
    byMonth: series(
      12,
      (i) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)),
      monthKey,
      byKey.month,
    ),
    byFeature: MODEL_USAGE_FEATURES.map((feature) => ({ feature, ...rowOf(byFeature.get(feature)!) })),
    byModel: Array.from(byModel.keys())
      .sort()
      .map((model) => ({ model, ...rowOf(byModel.get(model)!) })),
  };
}
