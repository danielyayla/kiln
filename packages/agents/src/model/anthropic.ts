import Anthropic from "@anthropic-ai/sdk";
import {
  CompleteRequest,
  type ModelProvider,
  type ModelResult,
  type Tier,
} from "./provider.js";

// Tier → model id. `reason` gets the most capable Opus-tier model for
// drafting/extraction; `light` gets the fastest, cheapest model for
// classification-style calls. Override per deployment via the constructor.
export const DEFAULT_TIER_MODELS: Record<Tier, string> = {
  reason: "claude-opus-4-8",
  light: "claude-haiku-4-5",
};

// Which tiers may request adaptive thinking on free-text calls. Haiku-class
// light models reject `thinking: adaptive` with a 400, so the light tier
// defaults off; override per deployment alongside the model ids.
export const DEFAULT_TIER_THINKING: Record<Tier, boolean> = {
  reason: true,
  light: false,
};

const DEFAULT_MAX_TOKENS = 16000;

export interface AnthropicModelProviderOptions {
  /** Tier → model id overrides; merged over DEFAULT_TIER_MODELS. */
  models?: Partial<Record<Tier, string>>;
  /**
   * Tier → adaptive-thinking capability; merged over DEFAULT_TIER_THINKING.
   * Set a tier true only if its model supports adaptive thinking.
   */
  adaptiveThinking?: Partial<Record<Tier, boolean>>;
  /** Default max_tokens when a request does not specify one. */
  maxTokens?: number;
  /**
   * Explicit API key for the constructed client (AI settings: the sidecar
   * resolves the key from the store and passes it here). When omitted, the
   * key is resolved from the host environment as before.
   */
  apiKey?: string;
  /**
   * Injection seam for tests. When omitted, a real client is constructed and
   * the API key is resolved from `apiKey` or the host environment
   * (ANTHROPIC_API_KEY or an `ant auth login` profile).
   */
  client?: Pick<Anthropic, "messages">;
}

export class AnthropicModelProvider implements ModelProvider {
  private client: Pick<Anthropic, "messages">;
  private models: Record<Tier, string>;
  private thinking: Record<Tier, boolean>;
  private maxTokens: number;

  constructor(options: AnthropicModelProviderOptions = {}) {
    if (options.client) {
      this.client = options.client;
    } else {
      // SDK ≥0.110 no longer throws at construction when credentials are
      // missing — it fails at request time instead. Provider-unavailable must
      // stay detectable without a model call (the sidecar's 503 route and
      // /health probe both construct a provider to ask exactly that), so
      // check here.
      const client = options.apiKey !== undefined ? new Anthropic({ apiKey: options.apiKey }) : new Anthropic();
      if (client.apiKey === null && client.authToken === null) {
        throw new Error("no Anthropic credentials found — set ANTHROPIC_API_KEY in the host environment");
      }
      this.client = client;
    }
    this.models = { ...DEFAULT_TIER_MODELS, ...options.models };
    this.thinking = { ...DEFAULT_TIER_THINKING, ...options.adaptiveThinking };
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async complete(req: CompleteRequest): Promise<ModelResult> {
    const { system, messages, tools, toolChoice, tier, maxTokens } = CompleteRequest.parse(req);
    const model = this.models[tier];

    // Structured output (BP-4): with exactly one "emit" tool we force the
    // model to call it, so the reply is always a schema-shaped tool input.
    // Forced tool_choice is incompatible with thinking, so thinking stays off
    // on that path; free-text calls use adaptive thinking only on tiers whose
    // model supports it (Haiku 400s on it). A caller can opt out of forcing
    // with `toolChoice: "auto"` (refine chat: prose or a tool call).
    const forcedTool = tools?.length === 1 && toolChoice !== "auto" ? tools[0] : undefined;

    const response = await this.client.messages.create({
      model,
      max_tokens: maxTokens ?? this.maxTokens,
      system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      ...(tools?.length
        ? {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
            })),
            tool_choice: forcedTool
              ? { type: "tool" as const, name: forcedTool.name }
              : { type: "auto" as const },
          }
        : this.thinking[tier]
          ? { thinking: { type: "adaptive" as const } }
          : {}),
    });

    let text = "";
    let toolCall: ModelResult["toolCall"] = null;
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use" && toolCall === null) {
        toolCall = { name: block.name, input: block.input };
      }
    }

    return {
      text,
      toolCall,
      stopReason: response.stop_reason,
      model: response.model,
      // The SDK types usage as always present, but injected test doubles (and
      // a defensive posture toward the wire) make the guard worthwhile.
      ...(response.usage
        ? { usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens } }
        : {}),
    };
  }
}
