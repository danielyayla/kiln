import { z } from "zod";

// The two capability tiers from BP-4: `reason` drives drafting/extraction,
// `light` covers cheap classification-style calls. Which concrete model backs
// each tier is configuration, never call-site knowledge.
export const TIERS = ["reason", "light"] as const;
export type Tier = (typeof TIERS)[number];

export const Message = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1),
});
export type Message = z.infer<typeof Message>;

// A tool offered to the model. For structured output, callers pass exactly one
// "emit" tool whose inputSchema is the shape they want back (BP-4).
export const Tool = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.record(z.unknown()), // JSON Schema object
});
export type Tool = z.infer<typeof Tool>;

// How the model may use a supplied emit tool. Default (`forced`) preserves the
// structured-output path: with exactly one tool the model MUST call it. `auto`
// lets the model choose prose or a tool call — required by conversational
// agents (refine) that answer questions AND propose edits from the same turn.
export const TOOL_CHOICES = ["forced", "auto"] as const;
export type ToolChoice = (typeof TOOL_CHOICES)[number];

export const CompleteRequest = z.object({
  system: z.string(),
  messages: z.array(Message).min(1),
  tools: z.array(Tool).optional(),
  toolChoice: z.enum(TOOL_CHOICES).optional(),
  tier: z.enum(TIERS),
  maxTokens: z.number().int().positive().optional(),
});
export type CompleteRequest = z.input<typeof CompleteRequest>;

// What a completion produced. When a single emit tool was supplied, `toolCall`
// carries its (unvalidated) input — callers Zod-parse it at their boundary.
export interface ToolCall {
  name: string;
  input: unknown;
}

export interface ModelResult {
  text: string;
  toolCall: ToolCall | null;
  stopReason: string | null;
  model: string;
  // Token counts for the call, when the backing API reports them. Optional so
  // scripted test providers (and any provider without metering) stay valid.
  usage?: { inputTokens: number; outputTokens: number };
}

// The one seam every agent uses for model access (BP-4). Keeping providers
// behind this interface is what makes the Anthropic dependency swappable and
// the agents testable without network access.
export interface ModelProvider {
  complete(req: CompleteRequest): Promise<ModelResult>;
}
