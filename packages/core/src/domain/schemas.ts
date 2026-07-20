import { z } from "zod";
import { ENTITY_TYPES, MODEL_USAGE_FEATURES, WORK_ORDER_STATUSES } from "./types";

export const NewEntity = z.object({
  type: z.enum(ENTITY_TYPES),
  title: z.string().min(1),
  body: z.string().default(""),
  status: z.enum(WORK_ORDER_STATUSES).nullable().optional(),
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
  assignee: z.string().nullable().optional(),
});
export type EntityPatch = z.infer<typeof EntityPatch>;
