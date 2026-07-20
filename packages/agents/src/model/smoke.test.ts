import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicModelProvider } from "./anthropic.js";

// Live round-trip against the real Anthropic API (WO-08 acceptance). Runs only
// when credentials are present in the host environment; CI without a key skips.
const hasCredentials = Boolean(
  process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.KILN_SMOKE_TEST,
);

const Greeting = z.object({
  greeting: z.string().min(1),
  language: z.string().min(1),
});

describe.skipIf(!hasCredentials)("AnthropicModelProvider (live smoke test)", () => {
  it("round-trips a small structured response through the emit tool", async () => {
    const provider = new AnthropicModelProvider();

    const result = await provider.complete({
      system: "You emit structured greetings. Use the emit_greeting tool.",
      messages: [{ role: "user", content: "Greet me in French." }],
      tools: [
        {
          name: "emit_greeting",
          description: "Emit the greeting as structured data.",
          inputSchema: {
            type: "object",
            properties: {
              greeting: { type: "string", description: "The greeting text" },
              language: { type: "string", description: "Language of the greeting" },
            },
            required: ["greeting", "language"],
            additionalProperties: false,
          },
        },
      ],
      tier: "light",
      maxTokens: 1024,
    });

    expect(result.toolCall?.name).toBe("emit_greeting");
    // The boundary contract: callers Zod-parse the emitted input.
    const parsed = Greeting.parse(result.toolCall?.input);
    expect(parsed.language.toLowerCase()).toContain("fr");
  }, 60_000);
});
