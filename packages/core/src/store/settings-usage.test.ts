import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { SqliteStore } from "./sqlite-store";

let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore(":memory:");
});
afterEach(() => store.close());

// createdAt is real-clock; two inserts can share a millisecond. Waiting for the
// clock to tick keeps the `since` boundary tests deterministic.
async function nextMillisecond(): Promise<void> {
  const start = new Date().toISOString();
  while (new Date().toISOString() === start) {
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe("settings", () => {
  it("returns null for an unset key", () => {
    expect(store.getSetting("ai.apiKey")).toBeNull();
  });

  it("round-trips a value and upserts on re-set", () => {
    store.setSetting("ai.provider", "anthropic");
    expect(store.getSetting("ai.provider")).toBe("anthropic");

    store.setSetting("ai.provider", "other");
    expect(store.getSetting("ai.provider")).toBe("other");
  });

  it("keeps keys independent", () => {
    store.setSetting("ai.enabled", "false");
    store.setSetting("ai.apiKey", "sk-test-1234");
    expect(store.getSetting("ai.enabled")).toBe("false");
    expect(store.getSetting("ai.apiKey")).toBe("sk-test-1234");
  });

  it("deletes a key, idempotently", () => {
    store.setSetting("ai.apiKey", "sk-test-1234");
    store.deleteSetting("ai.apiKey");
    expect(store.getSetting("ai.apiKey")).toBeNull();
    expect(() => store.deleteSetting("ai.apiKey")).not.toThrow(); // missing key is fine
  });
});

describe("model usage ledger", () => {
  it("records an entry and returns it complete (id + createdAt generated)", () => {
    const entry = store.recordModelUsage({
      feature: "draft",
      model: "claude-opus-4-8",
      inputTokens: 1200,
      outputTokens: 340,
    });
    expect(entry.id).toBeTruthy();
    expect(entry.createdAt).toBeTruthy();
    expect(entry).toMatchObject({
      feature: "draft",
      model: "claude-opus-4-8",
      inputTokens: 1200,
      outputTokens: 340,
    });
    expect(store.listModelUsage()).toEqual([entry]);
  });

  it("lists entries oldest-first in insertion order", () => {
    const a = store.recordModelUsage({ feature: "draft", model: "m", inputTokens: 1, outputTokens: 1 });
    const b = store.recordModelUsage({ feature: "chat", model: "m", inputTokens: 2, outputTokens: 2 });
    const c = store.recordModelUsage({ feature: "review", model: "m", inputTokens: 3, outputTokens: 3 });
    expect(store.listModelUsage().map((e) => e.id)).toEqual([a.id, b.id, c.id]);
  });

  it("filters with `since` as an inclusive lower bound", async () => {
    const a = store.recordModelUsage({ feature: "draft", model: "m", inputTokens: 1, outputTokens: 1 });
    await nextMillisecond();
    const b = store.recordModelUsage({ feature: "extract", model: "m", inputTokens: 2, outputTokens: 2 });

    expect(store.listModelUsage({ since: a.createdAt }).map((e) => e.id)).toEqual([a.id, b.id]);
    expect(store.listModelUsage({ since: b.createdAt }).map((e) => e.id)).toEqual([b.id]);
    expect(store.listModelUsage({ since: "2999-01-01T00:00:00.000Z" })).toEqual([]);
  });

  it("rejects an unknown feature and negative token counts", () => {
    expect(() =>
      store.recordModelUsage({
        // @ts-expect-error — unknown feature must fail at the Zod boundary
        feature: "export",
        model: "m",
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).toThrow(z.ZodError);
    expect(() =>
      store.recordModelUsage({ feature: "draft", model: "m", inputTokens: -1, outputTokens: 1 }),
    ).toThrow(z.ZodError);
    expect(() =>
      store.recordModelUsage({ feature: "draft", model: "", inputTokens: 1, outputTokens: 1 }),
    ).toThrow(z.ZodError);
  });
});
