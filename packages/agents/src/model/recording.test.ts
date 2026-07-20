import { describe, expect, it, vi } from "vitest";
import type { CompleteRequest, ModelProvider, ModelResult } from "./provider.js";
import { withUsageRecording, type ModelUsageEvent } from "./recording.js";

const REQ: CompleteRequest = { system: "s", messages: [{ role: "user", content: "hi" }], tier: "light" };

function scripted(results: ModelResult[]): ModelProvider {
  let i = 0;
  return {
    complete: async () => {
      const r = results[i];
      i += 1;
      return r;
    },
  };
}

describe("withUsageRecording", () => {
  it("reports one event per call with the SERVED model id, passing the result through", async () => {
    const result: ModelResult = {
      text: "ok",
      toolCall: null,
      stopReason: "end_turn",
      // the request asked for a tier; the event must carry the resolved model
      model: "claude-haiku-4-5",
      usage: { inputTokens: 120, outputTokens: 30 },
    };
    const events: ModelUsageEvent[] = [];
    const provider = withUsageRecording(scripted([result]), (u) => events.push(u));

    const out = await provider.complete(REQ);
    expect(out).toBe(result); // unchanged, same object
    expect(events).toEqual([{ model: "claude-haiku-4-5", inputTokens: 120, outputTokens: 30 }]);
  });

  it("records every call of a multi-call sequence", async () => {
    const mk = (model: string, n: number): ModelResult => ({
      text: "",
      toolCall: null,
      stopReason: "end_turn",
      model,
      usage: { inputTokens: n, outputTokens: n },
    });
    const events: ModelUsageEvent[] = [];
    const provider = withUsageRecording(scripted([mk("a", 1), mk("b", 2)]), (u) => events.push(u));

    await provider.complete(REQ);
    await provider.complete(REQ);
    expect(events.map((e) => e.model)).toEqual(["a", "b"]);
  });

  it("skips silently when a result carries no usage (scripted providers)", async () => {
    const result: ModelResult = { text: "ok", toolCall: null, stopReason: "end_turn", model: "scripted" };
    const onUsage = vi.fn();
    const provider = withUsageRecording(scripted([result]), onUsage);

    await expect(provider.complete(REQ)).resolves.toBe(result);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it("propagates a thrown call and records nothing for it", async () => {
    const onUsage = vi.fn();
    const failing: ModelProvider = {
      complete: async () => {
        throw new Error("model unavailable");
      },
    };
    const provider = withUsageRecording(failing, onUsage);

    await expect(provider.complete(REQ)).rejects.toThrow("model unavailable");
    expect(onUsage).not.toHaveBeenCalled();
  });
});
