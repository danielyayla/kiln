import { z } from "zod";
import { ENTITY_TYPES, MODEL_USAGE_FEATURES, WORK_ORDER_STATUSES, WORK_TYPES } from "./types";

export const NewEntity = z.object({
  type: z.enum(ENTITY_TYPES),
  title: z.string().min(1),
  body: z.string().default(""),
  status: z.enum(WORK_ORDER_STATUSES).nullable().optional(),
  workType: z.enum(WORK_TYPES).nullable().optional(),
  assignee: z.string().nullable().optional(),
});
export type NewEntity = z.input<typeof NewEntity>;

export const NewModelUsage = z.object({
  feature: z.enum(MODEL_USAGE_FEATURES),
  model: z.string().min(1),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});
export type NewModelUsage = z.input<typeof NewModelUsage>;

export const EntityPatch = z.object({
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  status: z.enum(WORK_ORDER_STATUSES).nullable().optional(),
  workType: z.enum(WORK_TYPES).nullable().optional(),
  assignee: z.string().nullable().optional(),
});
export type EntityPatch = z.infer<typeof EntityPatch>;

// Rejects empty and whitespace-only strings without transforming the value —
// reports are testimony, stored verbatim, so no silent trimming.
const nonBlank = (field: string) =>
  z.string().refine((s) => s.trim().length > 0, {
    message: `${field} must not be empty or whitespace-only`,
  });

// An agent's completion report — the input half of a completion receipt.
// `summary` is what was built, `verification` how it was proven (with real
// output). `commits`/`branch`/`filesTouched` are the agent's testimony about
// the code, recorded as given and never verified against a repository.
export const CompletionReport = z.object({
  summary: nonBlank("summary"),
  verification: nonBlank("verification"),
  commits: z.array(z.string()).default([]),
  branch: z.string().optional(),
  filesTouched: z.array(z.string()).default([]),
});
export type CompletionReport = z.input<typeof CompletionReport>;

// The persisted record: a completion report tied to its work order. Receipts
// are append-only and immutable — core exposes no update or delete surface.
export const CompletionReceipt = CompletionReport.extend({
  id: z.string().min(1),
  workOrderId: z.string().min(1),
  createdAt: z.string().min(1),
});
export type CompletionReceipt = z.infer<typeof CompletionReceipt>;
