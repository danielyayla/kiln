import { z } from "zod";
import { CRITICALITIES, ENTITY_TYPES, MODEL_USAGE_FEATURES, WORK_ORDER_STATUSES, WORK_TYPES } from "./types";

export const NewEntity = z.object({
  type: z.enum(ENTITY_TYPES),
  title: z.string().min(1),
  body: z.string().default(""),
  status: z.enum(WORK_ORDER_STATUSES).nullable().optional(),
  workType: z.enum(WORK_TYPES).nullable().optional(),
  criticality: z.enum(CRITICALITIES).nullable().optional(),
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
  criticality: z.enum(CRITICALITIES).nullable().optional(),
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

// A verdict on one acceptance criterion: the criterion text as judged, whether
// the completion receipt(s) show it met, and why. `undecidable` means the
// receipt gives no basis to judge either way — distinct from unmet.
export const VERDICT_STATUSES = ["met", "unmet", "undecidable"] as const;
export type VerdictStatus = (typeof VERDICT_STATUSES)[number];

export const CriterionVerdict = z.object({
  criterion: nonBlank("criterion"),
  status: z.enum(VERDICT_STATUSES),
  reason: nonBlank("reason"),
});
export type CriterionVerdict = z.infer<typeof CriterionVerdict>;

// The verify agent's structured output — shared by the agent and the app so
// both sides validate the same shape. `criteria` may be empty (a work order
// with no acceptance list still gets an overall verdict, typically
// undecidable); `overall` is the single judgment across all criteria.
export const VerificationVerdict = z.object({
  criteria: z.array(CriterionVerdict),
  overall: z.enum(VERDICT_STATUSES),
});
export type VerificationVerdict = z.infer<typeof VerificationVerdict>;

// The persisted record: a verdict tied to its work order. Like completion
// receipts, verification receipts are append-only and immutable — core
// exposes no update or delete surface; re-verification appends.
export const VerificationReceipt = VerificationVerdict.extend({
  id: z.string().min(1),
  workOrderId: z.string().min(1),
  createdAt: z.string().min(1),
});
export type VerificationReceipt = z.infer<typeof VerificationReceipt>;
