import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Entity } from "../domain";
import { SqliteStore } from "../store/sqlite-store";
import { driftChecks } from "./drift";

let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore(":memory:");
});
afterEach(() => {
  store.close();
});

const receipt = (workOrderId: string, createdAt: string) => {
  store.saveCompletionReceipt({
    id: `r-${workOrderId}-${createdAt}`,
    workOrderId,
    summary: "built it",
    verification: "tests pass: 12 passed",
    commits: [],
    filesTouched: [],
    createdAt,
  });
};

const codes = (e: Entity) => driftChecks(store, store.getEntity(e.id)!).map((c) => c.code);
const check = (e: Entity, code: string) => driftChecks(store, store.getEntity(e.id)!).find((c) => c.code === code);

const T1 = "2026-01-01T00:00:00.000Z";
const T2 = "2026-01-02T00:00:00.000Z";

describe("revised-after-done", () => {
  it("flags a done work order revised strictly after its latest receipt", () => {
    const wo = store.createEntity({ type: "work_order", title: "WO", body: "x" });
    store.updateEntity(wo.id, { status: "done" });
    receipt(wo.id, T1);
    store.commitBody(wo.id, "revised"); // revision stamped now, after T1
    expect(check(wo, "revised-after-done")?.level).toBe("warn");
  });

  it("stays quiet when the revision predates the receipt", () => {
    const wo = store.createEntity({ type: "work_order", title: "WO", body: "x" });
    store.commitBody(wo.id, "revised before ship");
    store.updateEntity(wo.id, { status: "done" });
    receipt(wo.id, "9999-01-01T00:00:00.000Z");
    expect(codes(wo)).toEqual([]);
  });

  it("stays quiet on an unrevised done work order and on non-done statuses", () => {
    const done = store.createEntity({ type: "work_order", title: "WO", body: "x" });
    store.updateEntity(done.id, { status: "done" });
    receipt(done.id, T1);
    expect(codes(done)).toEqual([]);

    const open = store.createEntity({ type: "work_order", title: "WO2", body: "x" });
    store.updateEntity(open.id, { status: "in_progress" });
    receipt(open.id, T1);
    store.commitBody(open.id, "revised");
    expect(codes(open)).toEqual([]);
  });

  it("compares against the LATEST receipt when several exist", () => {
    const wo = store.createEntity({ type: "work_order", title: "WO", body: "x" });
    store.updateEntity(wo.id, { status: "done" });
    receipt(wo.id, T1);
    store.commitBody(wo.id, "revised after first receipt");
    receipt(wo.id, "9999-01-01T00:00:00.000Z");
    expect(codes(wo)).toEqual([]);
  });

  it("does not flag a same-instant revision and receipt (strictly-after)", () => {
    const wo = store.createEntity({ type: "work_order", title: "WO", body: "x" });
    store.updateEntity(wo.id, { status: "done" });
    const { revision } = store.commitBody(wo.id, "closing edit");
    receipt(wo.id, revision.createdAt);
    expect(codes(wo)).toEqual([]);
  });
});

describe("amended-after-ship", () => {
  const shippedPair = () => {
    const bp = store.createEntity({ type: "blueprint", title: "BP", body: "x" });
    const wo = store.createEntity({ type: "work_order", title: "WO", body: "x" });
    store.link(wo.id, bp.id, "implements");
    store.updateEntity(wo.id, { status: "done" });
    receipt(wo.id, T1);
    return { bp, wo };
  };

  it("flags a blueprint amended after all implementing work orders closed", () => {
    const { bp } = shippedPair();
    store.commitBody(bp.id, "amended after ship");
    expect(check(bp, "amended-after-ship")?.level).toBe("warn");
  });

  it("clears when an open implementing work order exists (mid-reconciliation)", () => {
    const { bp } = shippedPair();
    store.commitBody(bp.id, "amended after ship");
    const reconciler = store.createEntity({ type: "work_order", title: "Reconcile", body: "x" });
    store.link(reconciler.id, bp.id, "implements");
    expect(codes(bp)).toEqual([]);
  });

  it("stays quiet on a blueprint with no implementing work orders", () => {
    const bp = store.createEntity({ type: "blueprint", title: "BP", body: "x" });
    store.commitBody(bp.id, "amended");
    expect(codes(bp)).toEqual([]);
  });

  it("stays quiet when the amendment predates the latest receipt across work orders", () => {
    const { bp, wo } = shippedPair();
    store.commitBody(bp.id, "amended between receipts");
    receipt(wo.id, "9999-01-01T00:00:00.000Z");
    expect(codes(bp)).toEqual([]);
  });

  it("stays quiet when no implementing work order has a receipt (no clock)", () => {
    const bp = store.createEntity({ type: "blueprint", title: "BP", body: "x" });
    const wo = store.createEntity({ type: "work_order", title: "WO", body: "x" });
    store.link(wo.id, bp.id, "implements");
    store.updateEntity(wo.id, { status: "done" });
    store.commitBody(bp.id, "amended");
    expect(codes(bp)).toEqual([]);
  });

  it("does not flag a same-instant amendment and receipt (strictly-after)", () => {
    const bp = store.createEntity({ type: "blueprint", title: "BP", body: "x" });
    const wo = store.createEntity({ type: "work_order", title: "WO", body: "x" });
    store.link(wo.id, bp.id, "implements");
    store.updateEntity(wo.id, { status: "done" });
    const { revision } = store.commitBody(bp.id, "amended");
    receipt(wo.id, revision.createdAt);
    expect(codes(bp)).toEqual([]);
  });

  it("a cancelled implementing work order does not forgive drift", () => {
    const { bp } = shippedPair();
    const cancelled = store.createEntity({ type: "work_order", title: "Dropped", body: "x" });
    store.link(cancelled.id, bp.id, "implements");
    store.updateEntity(cancelled.id, { status: "cancelled" });
    store.commitBody(bp.id, "amended after ship");
    expect(codes(bp)).toContain("amended-after-ship");
  });
});

describe("done-without-receipt", () => {
  it("flags a done work order with no completion receipt as info", () => {
    const wo = store.createEntity({ type: "work_order", title: "WO", body: "x" });
    store.updateEntity(wo.id, { status: "done" });
    expect(check(wo, "done-without-receipt")?.level).toBe("info");
  });

  it("stays quiet once a receipt exists", () => {
    const wo = store.createEntity({ type: "work_order", title: "WO", body: "x" });
    store.updateEntity(wo.id, { status: "done" });
    receipt(wo.id, T2);
    expect(codes(wo)).not.toContain("done-without-receipt");
  });

  it("never flags non-done statuses, including the draft default", () => {
    const draft = store.createEntity({ type: "work_order", title: "WO", body: "x" });
    expect(codes(draft)).toEqual([]);
    store.updateEntity(draft.id, { status: "in_progress" });
    expect(codes(draft)).toEqual([]);
    store.updateEntity(draft.id, { status: "cancelled" });
    expect(codes(draft)).toEqual([]);
  });
});
