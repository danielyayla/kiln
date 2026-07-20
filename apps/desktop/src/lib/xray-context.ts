import type { ContextHealth, ContextReceipt, Entity, WorkOrderContext } from "@kiln/core";

export type XRayContextSeverity = "ready" | ContextHealth["checks"][number]["level"];
export type XRayHandoffState = "never" | "current" | "changed";

export type XRayContextChainItem = {
  type: "requirement" | "blueprint" | "work_order";
  title: string;
  entity: Entity | null;
};

export type XRayInheritedContext = {
  requirement: Entity;
  artifacts: Entity[];
};

export type XRayContextSummary = {
  chain: XRayContextChainItem[];
  directArtifacts: Entity[];
  inherited: XRayInheritedContext[];
  counts: { direct: number; inherited: number };
  estTokens: number;
  severity: XRayContextSeverity;
  handoff: XRayHandoffState;
};

export type ContextReceiptWithContext = ContextReceipt & { context: WorkOrderContext };

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function worstSeverity(health: ContextHealth): XRayContextSeverity {
  const rank: Record<XRayContextSeverity, number> = { ready: 0, info: 1, warn: 2, error: 3 };
  return health.checks.reduce<XRayContextSeverity>(
    (worst, check) => (rank[check.level] > rank[worst] ? check.level : worst),
    "ready",
  );
}

function handoffState(context: WorkOrderContext, receipts: ContextReceiptWithContext[]): XRayHandoffState {
  const latest = receipts.at(-1);
  if (!latest) return "never";
  return stableJson(context) === stableJson(latest.context) ? "current" : "changed";
}

export function summarizeXRayContext(
  context: WorkOrderContext,
  health: ContextHealth,
  receipts: ContextReceiptWithContext[],
): XRayContextSummary {
  const inherited = context.lineage.map(({ requirement, artifacts }) => ({ requirement, artifacts }));
  return {
    chain: [
      {
        type: "requirement",
        title: context.requirement?.title ?? "Missing requirement",
        entity: context.requirement,
      },
      {
        type: "blueprint",
        title: context.blueprint?.title ?? "Missing blueprint",
        entity: context.blueprint,
      },
      { type: "work_order", title: context.workOrder.title, entity: context.workOrder },
    ],
    directArtifacts: context.artifacts,
    inherited,
    counts: {
      direct: context.artifacts.length,
      inherited: inherited.reduce((total, entry) => total + entry.artifacts.length, 0),
    },
    estTokens: health.size.estTokens,
    severity: worstSeverity(health),
    handoff: handoffState(context, receipts),
  };
}
