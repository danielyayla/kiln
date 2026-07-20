import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../store/sqlite-store";
import { hashContext, recordContextReceipt } from "./receipt";

let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore(":memory:");
});
afterEach(() => store.close());

// A work order implementing a blueprint that details a requirement, so the
// assembled context has real content to hash.
function seed() {
  const req = store.createEntity({ type: "requirement", title: "R", body: "the intent" });
  const bp = store.createEntity({ type: "blueprint", title: "B", body: "the approach" });
  const wo = store.createEntity({ type: "work_order", title: "W", body: "do it", status: "ready" });
  store.link(bp.id, req.id, "details");
  store.link(wo.id, bp.id, "implements");
  return { req, bp, wo };
}

describe("hashContext", () => {
  it("is stable regardless of object key order", () => {
    expect(hashContext({ a: 1, b: [2, 3] })).toBe(hashContext({ b: [2, 3], a: 1 }));
  });
  it("changes when content changes", () => {
    expect(hashContext({ a: 1 })).not.toBe(hashContext({ a: 2 }));
  });
});

describe("recordContextReceipt", () => {
  it("records a receipt on first handoff", () => {
    const { wo } = seed();
    const r = recordContextReceipt(store, wo.id);
    expect(store.listContextReceipts(wo.id)).toHaveLength(1);
    expect(store.latestContextReceipt(wo.id)?.id).toBe(r.id);
    expect(r.hash).toHaveLength(64); // sha256 hex
  });

  it("dedupes an identical re-handoff (no new row, same receipt returned)", () => {
    const { wo } = seed();
    const first = recordContextReceipt(store, wo.id);
    const again = recordContextReceipt(store, wo.id);
    expect(again.id).toBe(first.id); // same receipt, not a new one
    expect(store.listContextReceipts(wo.id)).toHaveLength(1);
  });

  it("records a new receipt after the assembled context changes", () => {
    const { req, wo } = seed();
    const first = recordContextReceipt(store, wo.id);

    // Editing the requirement changes the assembled context (body + updatedAt).
    store.updateEntity(req.id, { body: "the intent, clarified" });
    const second = recordContextReceipt(store, wo.id);

    expect(second.id).not.toBe(first.id);
    expect(second.hash).not.toBe(first.hash);
    expect(store.listContextReceipts(wo.id).map((r) => r.id)).toEqual([first.id, second.id]);
  });

  it("throws for an unknown work order (nothing to assemble)", () => {
    expect(() => recordContextReceipt(store, "nope")).toThrow();
  });
});
