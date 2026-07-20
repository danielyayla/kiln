import { z } from "zod";

// A document edit expressed as anchor-addressed operations. Agents emit these
// instead of overwriting a document, so each op can be accepted/rejected on its own.
export const EditOp = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("insert"), anchor: z.string(), text: z.string() }),
  z.object({ kind: z.literal("delete"), anchor: z.string() }),
  z.object({ kind: z.literal("replace"), anchor: z.string(), text: z.string() }),
]);
export type EditOp = z.infer<typeof EditOp>;

export const SuggestionSource = z.enum([
  "draft_agent",
  "extract_agent",
  "refine_agent",
  "review_agent",
  "human",
]);
export type SuggestionSource = z.infer<typeof SuggestionSource>;

export const Suggestion = z.object({
  id: z.string(),
  targetId: z.string(),
  source: SuggestionSource,
  ops: z.array(EditOp).min(1),
});
export type Suggestion = z.infer<typeof Suggestion>;
