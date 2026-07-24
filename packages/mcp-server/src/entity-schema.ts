import { z } from "zod";
import { CRITICALITIES, ENTITY_TYPES, WORK_ORDER_STATUSES, WORK_TYPES } from "@kiln/core";

// Zod mirror of the core `Entity` shape, used as MCP tool output schemas so
// clients receive validated, self-describing structured content. Keep every
// field of core's `Entity` mirrored here in the same order: because Zod objects
// compile to JSON Schema with `additionalProperties: false`, a field the store
// emits but this mirror omits makes strict MCP clients reject the response.
export const entitySchema = z.object({
  id: z.string(),
  type: z.enum(ENTITY_TYPES),
  title: z.string(),
  body: z.string(),
  status: z.enum(WORK_ORDER_STATUSES).nullable(),
  workType: z.enum(WORK_TYPES).nullable(),
  criticality: z.enum(CRITICALITIES).nullable(),
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
// lineage (Phase 6). `workType` and `guidance` (BP-18) are tier-1 actionable:
// the order's effective type and the per-type execution discipline to follow.
export const workOrderContextShape = {
  workOrder: entitySchema,
  workType: z.enum(WORK_TYPES),
  guidance: z.string(),
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

// One proposed document in a `propose_feature` call: the title the entity is
// created with and the body that lands as a pending suggestion (or, for
// evidence, directly). Caps and health rules are enforced in the handler so
// rejections can name the offending document.
export const proposedDocumentSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
});

// Output shape of `propose_feature`: every id the materialization created.
// `suggestionIds` is [requirement suggestion, blueprint suggestion].
export const proposalResultShape = {
  requirementId: z.string(),
  blueprintId: z.string(),
  artifactIds: z.array(z.string()),
  suggestionIds: z.array(z.string()),
};

// Output shape of `propose_root_overview`: the (pre-existing) root pair the
// suggestions landed on, the evidence artifacts created, and `suggestionIds`
// as [overview suggestion, architecture suggestion].
export const rootProposalResultShape = {
  rootRequirementId: z.string(),
  blueprintId: z.string(),
  artifactIds: z.array(z.string()),
  suggestionIds: z.array(z.string()),
};

// Output shape of `get_project_shape`: core's ProjectShape verbatim — the
// one-call populated-project signal for surveying agents.
export const projectShapeShape = {
  shape: z.enum(["empty", "fresh", "populated"]),
  rootTitle: z.string().nullable(),
  counts: z.object({
    requirements: z.number(),
    blueprints: z.number(),
    workOrders: z.number(),
    artifacts: z.number(),
  }),
  pendingSuggestions: z.number(),
};

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
