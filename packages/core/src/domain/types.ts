export type Id = string;

export const ENTITY_TYPES = ["artifact", "requirement", "blueprint", "work_order"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const LINK_TYPES = ["implements", "details", "references", "child_of", "depends_on"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export const WORK_ORDER_STATUSES = ["draft", "ready", "in_progress", "done", "cancelled"] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

// Work types classify work orders (BP-18); the set is closed. `feature` is
// never stored implicitly — absence means "unset", and effectiveWorkType is
// the one place the default lives.
export const WORK_TYPES = ["feature", "bug", "refactor", "perf", "chore"] as const;
export type WorkType = (typeof WORK_TYPES)[number];

export const effectiveWorkType = (e: Pick<Entity, "workType">): WorkType => e.workType ?? "feature";

export interface Entity {
  id: Id;
  type: EntityType;
  title: string;
  body: string;
  status: WorkOrderStatus | null;
  workType: WorkType | null;
  assignee: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Link {
  fromId: Id;
  toId: Id;
  type: LinkType;
}

export interface Revision {
  id: Id;
  entityId: Id;
  body: string;
  createdAt: string;
}

export const MODEL_USAGE_FEATURES = ["draft", "extract", "chat", "review"] as const;
export type ModelUsageFeature = (typeof MODEL_USAGE_FEATURES)[number];

// One row per model call made through the app (AI settings & usage): which
// feature triggered it, which model actually served it, and the token counts.
// Token counts only — prompt and response bodies are never stored.
export interface ModelUsage {
  id: Id;
  feature: ModelUsageFeature;
  model: string;
  inputTokens: number;
  outputTokens: number;
  createdAt: string;
}

// An immutable, timestamped snapshot of the context assembled for a work order
// at the moment it was handed to an agent (Phase 8 — provenance). `context` is a
// frozen WorkOrderContext, stored opaquely so the store layer needs no graph
// types; consumers parse it back as a WorkOrderContext. `hash` is a stable hash
// of that context, used to deduplicate identical re-handoffs.
export interface ContextReceipt {
  id: Id;
  workOrderId: Id;
  context: unknown;
  hash: string;
  createdAt: string;
}
