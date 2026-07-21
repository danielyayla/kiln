import { z } from "zod";
import { ENTITY_TYPES, WORK_ORDER_STATUSES } from "@kiln/core";

// Zod mirror of the core `Entity` shape, used as MCP tool output schemas so
// clients receive validated, self-describing structured content.
export const entitySchema = z.object({
  id: z.string(),
  type: z.enum(ENTITY_TYPES),
  title: z.string(),
  body: z.string(),
  status: z.enum(WORK_ORDER_STATUSES).nullable(),
  assignee: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// A depends_on target reported alongside a work order's context, so an agent
// can explain why the work is sequenced.
export const dependencyInfoSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(WORK_ORDER_STATUSES).nullable(),
});

// One rung of inherited intent (Phase 6): an ancestor requirement and the
// artifacts it references, nearest-first in the work order's lineage. The
// ancestor's `details` blueprint rides along when one exists (Phase 14) —
// absent, not null, otherwise (matching core's LineageEntry).
export const lineageEntrySchema = z.object({
  requirement: entitySchema,
  artifacts: z.array(entitySchema),
  blueprint: entitySchema.optional(),
});

// Output shape of `get_work_order`: the full assembled context (BP-2) plus the
// work order's declared dependencies (FRD-3) and its inherited ancestor
// lineage (Phase 6).
export const workOrderContextShape = {
  workOrder: entitySchema,
  blueprint: entitySchema.nullable(),
  requirement: entitySchema.nullable(),
  artifacts: z.array(entitySchema),
  dependencies: z.array(dependencyInfoSchema),
  lineage: z.array(lineageEntrySchema),
};

// Output shape of `list_ready_work_orders`.
export const readyWorkOrderSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
});

// An agent's completion report — required when closing in_progress → done, the
// return half of the handoff loop. Mirror of core's CompletionReport, which
// re-validates authoritatively inside recordCompletionReceipt (rejecting
// whitespace-only fields and defaulting the testimony lists).
export const completionReportSchema = z.object({
  summary: z.string().min(1),
  verification: z.string().min(1),
  commits: z.array(z.string()).optional(),
  branch: z.string().optional(),
  filesTouched: z.array(z.string()).optional(),
});
