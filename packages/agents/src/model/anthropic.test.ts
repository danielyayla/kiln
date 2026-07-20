import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicModelProvider, DEFAULT_TIER_MODELS } from "./anthropic.js";

// A fake client capturing the request and returning a canned response.
function fakeClient(response: Partial<Anthropic.Message>) {
  const create = vi.fn().mockResolvedValue({
    content: [],
    stop_reason: "end_turn",
    model: "fake-model",
    ...response,
  });
  return { client: { messages: { create } } as unknown as Pick<Anthropic, "messages">, create };
}

const EMIT_TOOL = {
  name: "emit_greeting",
  description: "Emit a structured greeting.",
  inputSchema: {
    type: "object",
    properties: { greeting: { type: "string" } },
    required: ["greeting"],
    additionalProperties: false,
  },
};

describe("AnthropicModelProvider", () => {
  it("throws at construction when the host has no credentials", () => {
    // The SDK (≥0.110) defers missing-credential errors to request time; the
    // provider must surface them at construction so provider-unavailable is
    // detectable without a model call. Scrub every env credential the SDK
    // reads, then expect the constructor itself to refuse.
    const saved: Record<string, string | undefined> = {};
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    try {
      expect(() => new AnthropicModelProvider()).toThrow(/no Anthropic credentials/);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  });

  it("maps tiers to models via the default config", async () => {
    const { client, create } = fakeClient({});
    const provider = new AnthropicModelProvider({ client });

    await provider.complete({ system: "s", messages: [{ role: "user", content: "hi" }], tier: "reason" });
    expect(create.mock.calls[0][0].model).toBe(DEFAULT_TIER_MODELS.reason);

    await provider.complete({ system: "s", messages: [{ role: "user", content: "hi" }], tier: "light" });
    expect(create.mock.calls[1][0].model).toBe(DEFAULT_TIER_MODELS.light);
  });

  it("honours per-tier model overrides from config", async () => {
    const { client, create } = fakeClient({});
    const provider = new AnthropicModelProvider({ client, models: { light: "custom-light-model" } });

    await provider.complete({ system: "s", messages: [{ role: "user", content: "hi" }], tier: "light" });
    expect(create.mock.calls[0][0].model).toBe("custom-light-model");

    await provider.complete({ system: "s", messages: [{ role: "user", content: "hi" }], tier: "reason" });
    expect(create.mock.calls[1][0].model).toBe(DEFAULT_TIER_MODELS.reason);
  });

  it("forces tool_choice onto a single emit tool and disables thinking", async () => {
    const { client, create } = fakeClient({
      content: [{ type: "tool_use", id: "tu_1", name: "emit_greeting", input: { greeting: "hello" } }],
      stop_reason: "tool_use",
    } as Partial<Anthropic.Message>);
    const provider = new AnthropicModelProvider({ client });

    const result = await provider.complete({
      system: "Emit a greeting.",
      messages: [{ role: "user", content: "Say hello" }],
      tools: [EMIT_TOOL],
      tier: "light",
    });

    const req = create.mock.calls[0][0];
    expect(req.tool_choice).toEqual({ type: "tool", name: "emit_greeting" });
    expect(req.tools).toEqual([
      { name: "emit_greeting", description: "Emit a structured greeting.", input_schema: EMIT_TOOL.inputSchema },
    ]);
    expect(req.thinking).toBeUndefined();

    expect(result.toolCall).toEqual({ name: "emit_greeting", input: { greeting: "hello" } });
  });

  it("offers a single tool as auto (not forced) when toolChoice is auto", async () => {
    const { client, create } = fakeClient({
      content: [{ type: "text", text: "just answering" }],
      stop_reason: "end_turn",
    } as Partial<Anthropic.Message>);
    const provider = new AnthropicModelProvider({ client });

    const result = await provider.complete({
      system: "Chat.",
      messages: [{ role: "user", content: "What does this say?" }],
      tools: [EMIT_TOOL],
      toolChoice: "auto",
      tier: "reason",
    });

    const req = create.mock.calls[0][0];
    expect(req.tool_choice).toEqual({ type: "auto" });
    expect(req.tools).toHaveLength(1);
    expect(result.text).toBe("just answering");
    expect(result.toolCall).toBeNull();
  });

  it("uses adaptive thinking on free-text calls for tiers that support it", async () => {
    const { client, create } = fakeClient({
      content: [{ type: "text", text: "hello there" }],
    } as Partial<Anthropic.Message>);
    const provider = new AnthropicModelProvider({ client });

    const result = await provider.complete({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      tier: "reason",
    });

    expect(create.mock.calls[0][0].thinking).toEqual({ type: "adaptive" });
    expect(create.mock.calls[0][0].tools).toBeUndefined();
    expect(result.text).toBe("hello there");
    expect(result.toolCall).toBeNull();
  });

  it("omits thinking on light-tier free-text calls (Haiku rejects adaptive thinking)", async () => {
    const { client, create } = fakeClient({
      content: [{ type: "text", text: "quick answer" }],
    } as Partial<Anthropic.Message>);
    const provider = new AnthropicModelProvider({ client });

    await provider.complete({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      tier: "light",
    });

    expect(create.mock.calls[0][0].thinking).toBeUndefined();
    expect(create.mock.calls[0][0].tools).toBeUndefined();
  });

  it("honours per-tier adaptiveThinking overrides", async () => {
    const { client, create } = fakeClient({
      content: [{ type: "text", text: "hi" }],
    } as Partial<Anthropic.Message>);
    // A deployment whose light model supports thinking may opt it back in.
    const provider = new AnthropicModelProvider({ client, adaptiveThinking: { light: true, reason: false } });

    await provider.complete({ system: "s", messages: [{ role: "user", content: "hi" }], tier: "light" });
    expect(create.mock.calls[0][0].thinking).toEqual({ type: "adaptive" });

    await provider.complete({ system: "s", messages: [{ role: "user", content: "hi" }], tier: "reason" });
    expect(create.mock.calls[1][0].thinking).toBeUndefined();
  });

  it("rejects malformed requests at the Zod boundary", async () => {
    const { client } = fakeClient({});
    const provider = new AnthropicModelProvider({ client });

    await expect(
      provider.complete({ system: "s", messages: [], tier: "reason" }),
    ).rejects.toThrow();
    await expect(
      // @ts-expect-error — invalid tier must be rejected at runtime too
      provider.complete({ system: "s", messages: [{ role: "user", content: "hi" }], tier: "huge" }),
    ).rejects.toThrow();
  });

  it("accepts an explicit apiKey option in place of env credentials", () => {
    // Same env scrub as the no-credentials test: with everything removed, an
    // explicit apiKey alone must satisfy the constructor's credential check.
    const saved: Record<string, string | undefined> = {};
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    try {
      expect(() => new AnthropicModelProvider({ apiKey: "sk-test-explicit" })).not.toThrow();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  });

  it("maps response.usage onto the result's token counts", async () => {
    const { client } = fakeClient({
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 321, output_tokens: 54 },
    } as Partial<Anthropic.Message>);
    const provider = new AnthropicModelProvider({ client });

    const result = await provider.complete({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      tier: "light",
    });
    expect(result.usage).toEqual({ inputTokens: 321, outputTokens: 54 });
  });

  it("omits usage when the response carries none", async () => {
    const { client } = fakeClient({
      content: [{ type: "text", text: "hi" }],
    } as Partial<Anthropic.Message>);
    const provider = new AnthropicModelProvider({ client });

    const result = await provider.complete({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      tier: "light",
    });
    expect(result.usage).toBeUndefined();
  });

  it("concatenates multiple text blocks", async () => {
    const { client } = fakeClient({
      content: [
        { type: "text", text: "part one, " },
        { type: "text", text: "part two" },
      ],
    } as Partial<Anthropic.Message>);
    const provider = new AnthropicModelProvider({ client });

    const result = await provider.complete({
      system: "s",
      messages: [{ role: "user", content: "hi" }],
      tier: "light",
    });
    expect(result.text).toBe("part one, part two");
  });
});
