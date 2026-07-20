import type { ModelProvider } from "./provider.js";

// What one metered model call reports (AI settings & usage): the model that
// actually SERVED the call (from the result, not the requested tier) and its
// token counts. The consumer decides persistence — the sidecar maps this onto
// the store's ledger with the triggering feature attached.
export interface ModelUsageEvent {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

// Wraps a provider so every successful complete() reports its token usage —
// correct regardless of how many calls an agent makes internally, because the
// seam is the provider, not the agent. Results and errors pass through
// unchanged; a thrown call reports nothing; a result without usage (scripted
// test providers, unmetered backends) is skipped silently.
export function withUsageRecording(
  provider: ModelProvider,
  onUsage: (usage: ModelUsageEvent) => void,
): ModelProvider {
  return {
    async complete(req) {
      const result = await provider.complete(req);
      if (result.usage) {
        onUsage({
          model: result.model,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
        });
      }
      return result;
    },
  };
}
