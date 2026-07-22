import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const receipt = (workOrderId: string, createdAt: string, filesTouched: string[] = []) => {
  store.saveCompletionReceipt({
    id: `r-${workOrderId}-${createdAt}`,
    workOrderId,
    summary: "built it",
    verification: "tests pass: 12 passed",
    commits: [],
    filesTouched,
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

describe("reconciliation is content, not clocks", () => {
  // commitBody stamps the real clock, so these cases pin it with fake timers
  // to place revisions on either side of the ship time deterministically.
  const T0 = "2025-12-31T00:00:00.000Z";
  const T3 = "2026-01-03T00:00:00.000Z";
  const at = (iso: string) => vi.setSystemTime(new Date(iso));
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("clears amended-after-ship when the body is reverted to the ship-time snapshot", () => {
    const bp = store.createEntity({ type: "blueprint", title: "BP", body: "x" });
    const wo = store.createEntity({ type: "work_order", title: "WO", body: "x" });
    store.link(wo.id, bp.id, "implements");
    store.updateEntity(wo.id, { status: "done" });
    at(T1);
    store.commitBody(bp.id, "shipped design");
    receipt(wo.id, T1);
    at(T2);
    store.commitBody(bp.id, "amended after ship");
    expect(codes(bp)).toContain("amended-after-ship");
    at(T3);
    store.commitBody(bp.id, "shipped design"); // the revert
    expect(codes(bp)).toEqual([]);
  });

  it("clears revised-after-done when the body is reverted to the receipt-time snapshot", () => {
    const wo = store.createEntity({ type: "work_order", title: "WO", body: "x" });
    store.updateEntity(wo.id, { status: "done" });
    at(T1);
    store.commitBody(wo.id, "shipped body");
    receipt(wo.id, T1);
    at(T2);
    store.commitBody(wo.id, "revised after done");
    expect(codes(wo)).toContain("revised-after-done");
    at(T3);
    store.commitBody(wo.id, "shipped body"); // the revert
    expect(codes(wo)).toEqual([]);
  });

  it("compares against the LATEST snapshot at or before the ship time", () => {
    const bp = store.createEntity({ type: "blueprint", title: "BP", body: "x" });
    const wo = store.createEntity({ type: "work_order", title: "WO", body: "x" });
    store.link(wo.id, bp.id, "implements");
    store.updateEntity(wo.id, { status: "done" });
    at(T0);
    store.commitBody(bp.id, "early draft");
    at(T1);
    store.commitBody(bp.id, "shipped design");
    receipt(wo.id, T1);
    at(T2);
    store.commitBody(bp.id, "early draft"); // matches a snapshot, but not the shipped one
    expect(codes(bp)).toContain("amended-after-ship");
    at(T3);
    store.commitBody(bp.id, "shipped design");
    expect(codes(bp)).toEqual([]);
  });

  it("falls back to the clock alone when no snapshot exists at or before the ship time", () => {
    // The creation body is never snapshotted, so a first-ever commit after the
    // receipt has no baseline — it flags even if the body text is unchanged.
    const wo = store.createEntity({ type: "work_order", title: "WO", body: "x" });
    store.updateEntity(wo.id, { status: "done" });
    receipt(wo.id, T1);
    at(T2);
    store.commitBody(wo.id, "x");
    expect(codes(wo)).toContain("revised-after-done");
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

describe("shared-files", () => {
  // Two done work orders under different blueprints whose latest receipts
  // claim the given files.
  const crossBlueprintPair = (filesA: string[], filesB: string[]) => {
    const bpA = store.createEntity({ type: "blueprint", title: "BP A", body: "x" });
    const bpB = store.createEntity({ type: "blueprint", title: "BP B", body: "x" });
    const woA = store.createEntity({ type: "work_order", title: "WO A", body: "x" });
    const woB = store.createEntity({ type: "work_order", title: "WO B", body: "x" });
    store.link(woA.id, bpA.id, "implements");
    store.link(woB.id, bpB.id, "implements");
    store.updateEntity(woA.id, { status: "done" });
    store.updateEntity(woB.id, { status: "done" });
    receipt(woA.id, T1, filesA);
    receipt(woB.id, T1, filesB);
    return { woA, woB, bpA, bpB };
  };

  it("flags both sides of a cross-blueprint overlap, naming the file and the other title", () => {
    const { woA, woB } = crossBlueprintPair(["src/shared.ts", "src/a.ts"], ["src/shared.ts", "src/b.ts"]);
    const a = check(woA, "shared-files");
    expect(a?.level).toBe("info");
    expect(a?.message).toContain("src/shared.ts");
    expect(a?.message).toContain("WO B");
    expect(a?.message).not.toContain("src/a.ts");
    const b = check(woB, "shared-files");
    expect(b?.message).toContain("src/shared.ts");
    expect(b?.message).toContain("WO A");
  });

  it("lists every shared file when several overlap", () => {
    const { woA } = crossBlueprintPair(["src/x.ts", "src/y.ts", "src/only-a.ts"], ["src/x.ts", "src/y.ts"]);
    const msg = check(woA, "shared-files")?.message ?? "";
    expect(msg).toContain("src/x.ts");
    expect(msg).toContain("src/y.ts");
    expect(msg).not.toContain("src/only-a.ts");
  });

  it("stays quiet on same-blueprint overlap (sequential work shares files legitimately)", () => {
    const bp = store.createEntity({ type: "blueprint", title: "BP", body: "x" });
    const woA = store.createEntity({ type: "work_order", title: "WO A", body: "x" });
    const woB = store.createEntity({ type: "work_order", title: "WO B", body: "x" });
    store.link(woA.id, bp.id, "implements");
    store.link(woB.id, bp.id, "implements");
    store.updateEntity(woA.id, { status: "done" });
    store.updateEntity(woB.id, { status: "done" });
    receipt(woA.id, T1, ["src/shared.ts"]);
    receipt(woB.id, T1, ["src/shared.ts"]);
    expect(codes(woA)).toEqual([]);
    expect(codes(woB)).toEqual([]);
  });

  it("stays quiet when the other work order is not done", () => {
    const { woA, woB } = crossBlueprintPair(["src/shared.ts"], ["src/shared.ts"]);
    store.updateEntity(woB.id, { status: "in_progress" });
    expect(codes(woA)).toEqual([]);
    // ...and a non-done work order never flags itself either.
    expect(codes(woB)).toEqual([]);
  });

  it("stays quiet on empty filesTouched", () => {
    const { woA, woB } = crossBlueprintPair([], ["src/b.ts"]);
    expect(codes(woA)).toEqual([]);
    expect(codes(woB)).toEqual([]);
  });

  it("compares only the LATEST receipt on each side — superseded testimony never flags", () => {
    const { woA, woB } = crossBlueprintPair(["src/shared.ts"], ["src/shared.ts"]);
    receipt(woA.id, T2, ["src/moved-on.ts"]);
    expect(codes(woA)).toEqual([]);
    expect(codes(woB)).toEqual([]);
  });

  it("stays quiet when a work order implements no blueprint (cross-blueprint cannot be established)", () => {
    const bp = store.createEntity({ type: "blueprint", title: "BP", body: "x" });
    const linked = store.createEntity({ type: "work_order", title: "Linked", body: "x" });
    store.link(linked.id, bp.id, "implements");
    const orphan = store.createEntity({ type: "work_order", title: "Orphan", body: "x" });
    store.updateEntity(linked.id, { status: "done" });
    store.updateEntity(orphan.id, { status: "done" });
    receipt(linked.id, T1, ["src/shared.ts"]);
    receipt(orphan.id, T1, ["src/shared.ts"]);
    expect(codes(linked)).toEqual([]);
    expect(codes(orphan)).toEqual([]);
  });
});
