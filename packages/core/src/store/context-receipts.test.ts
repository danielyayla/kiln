import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assembleWorkOrderContext } from "../graph/context";
import { NotFoundError } from "../errors";
import { SqliteStore } from "./sqlite-store";
import type { ContextReceipt } from "../domain";

let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore(":memory:");
});
afterEach(() => store.close());

function receipt(workOrderId: string, hash: string): ContextReceipt {
  return {
    id: randomUUID(),
    workOrderId,
    context: assembleWorkOrderContext(store, workOrderId),
    hash,
    createdAt: new Date().toISOString(),
  };
}

describe("context receipts", () => {
  it("saves a receipt and reads it back, context round-tripping through JSON", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "ready" });
    const r = receipt(wo.id, "h1");
    store.saveContextReceipt(r);

    const list = store.listContextReceipts(wo.id);
    expect(list).toHaveLength(1);
    expect(list[0].hash).toBe("h1");
    expect(list[0].context).toEqual(r.context); // the frozen assembled context survives round-trip
  });

  it("lists receipts in insertion order and returns the most recent as latest", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "ready" });
    store.saveContextReceipt(receipt(wo.id, "h1"));
    store.saveContextReceipt(receipt(wo.id, "h2"));
    store.saveContextReceipt(receipt(wo.id, "h3"));

    // Ordered oldest→newest even when created_at ties within a millisecond
    // (rowid is the true insertion order).
    expect(store.listContextReceipts(wo.id).map((r) => r.hash)).toEqual(["h1", "h2", "h3"]);
    expect(store.latestContextReceipt(wo.id)?.hash).toBe("h3");
  });

  it("scopes receipts to their work order", () => {
    const a = store.createEntity({ type: "work_order", title: "A", status: "ready" });
    const b = store.createEntity({ type: "work_order", title: "B", status: "ready" });
    store.saveContextReceipt(receipt(a.id, "ha"));

    expect(store.listContextReceipts(a.id)).toHaveLength(1);
    expect(store.listContextReceipts(b.id)).toEqual([]);
    expect(store.latestContextReceipt(b.id)).toBeNull();
  });

  it("refuses a receipt for an unknown work order", () => {
    expect(() =>
      store.saveContextReceipt({
        id: randomUUID(),
        workOrderId: "does-not-exist",
        context: {},
        hash: "h",
        createdAt: new Date().toISOString(),
      }),
    ).toThrow(NotFoundError);
  });

  it("cascades receipts when the work order is deleted", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "ready" });
    store.saveContextReceipt(receipt(wo.id, "h1"));
    store.deleteEntity(wo.id);
    expect(store.listContextReceipts(wo.id)).toEqual([]);
  });
});
