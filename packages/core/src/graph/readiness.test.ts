import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../store/sqlite-store";
import { NotFoundError } from "../errors";
import { blockingDependencies, readyWorkOrders, workOrderDependencies } from "./readiness";

let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore(":memory:");
});
afterEach(() => {
  store.close();
});

describe("blockingDependencies", () => {
  it("returns depends_on targets that are not done", () => {
    const base = store.createEntity({ type: "work_order", title: "Groundwork", status: "in_progress" });
    const done = store.createEntity({ type: "work_order", title: "Finished dep", status: "done" });
    const wo = store.createEntity({ type: "work_order", title: "Feature", status: "ready" });
    store.link(wo.id, base.id, "depends_on");
    store.link(wo.id, done.id, "depends_on");

    const blockers = blockingDependencies(store, wo.id);
    expect(blockers.map((b) => b.id)).toEqual([base.id]);
  });

  it("is empty when a work order has no dependencies", () => {
    const wo = store.createEntity({ type: "work_order", title: "Standalone", status: "ready" });
    expect(blockingDependencies(store, wo.id)).toEqual([]);
  });

  it("throws NotFoundError for an unknown id", () => {
    expect(() => blockingDependencies(store, "nope")).toThrow(NotFoundError);
  });
});

describe("readyWorkOrders", () => {
  it("excludes a ready work order whose dependency is unfinished", () => {
    const dep = store.createEntity({ type: "work_order", title: "Prereq", status: "ready" });
    const wo = store.createEntity({ type: "work_order", title: "Blocked", status: "ready" });
    store.link(wo.id, dep.id, "depends_on");

    // The prereq is itself ready-and-unblocked, so it is offered; the dependent is not.
    expect(readyWorkOrders(store).map((w) => w.id)).toEqual([dep.id]);
  });

  it("unblocks the dependent once the dependency goes done", () => {
    const dep = store.createEntity({ type: "work_order", title: "Prereq", status: "ready" });
    const wo = store.createEntity({ type: "work_order", title: "Dependent", status: "ready" });
    store.link(wo.id, dep.id, "depends_on");

    expect(readyWorkOrders(store).map((w) => w.id)).toEqual([dep.id]);

    // Move the prereq through the lifecycle to done; now both would be free, but
    // only the dependent remains `ready` (the prereq left the ready set).
    store.updateEntity(dep.id, { status: "in_progress" });
    store.updateEntity(dep.id, { status: "done" });

    expect(readyWorkOrders(store).map((w) => w.id)).toEqual([wo.id]);
  });

  it("only considers `ready` work orders — a draft with met deps is not offered", () => {
    const dep = store.createEntity({ type: "work_order", title: "Prereq", status: "done" });
    const draft = store.createEntity({ type: "work_order", title: "Not ready yet", status: "draft" });
    store.link(draft.id, dep.id, "depends_on");
    expect(readyWorkOrders(store)).toEqual([]);
  });

  it("blocks every member of a dependency cycle without looping", () => {
    const a = store.createEntity({ type: "work_order", title: "A", status: "ready" });
    const b = store.createEntity({ type: "work_order", title: "B", status: "ready" });
    store.link(a.id, b.id, "depends_on");
    store.link(b.id, a.id, "depends_on");

    // Neither is done, so each blocks the other — the cycle withholds both, and
    // the call returns rather than spinning.
    expect(readyWorkOrders(store)).toEqual([]);
    expect(blockingDependencies(store, a.id).map((w) => w.id)).toEqual([b.id]);
    expect(blockingDependencies(store, b.id).map((w) => w.id)).toEqual([a.id]);
  });
});

describe("workOrderDependencies", () => {
  it("reports every dependency with id, title, and status", () => {
    const doneDep = store.createEntity({ type: "work_order", title: "Done dep", status: "done" });
    const openDep = store.createEntity({ type: "work_order", title: "Open dep", status: "ready" });
    const wo = store.createEntity({ type: "work_order", title: "Feature", status: "ready" });
    store.link(wo.id, doneDep.id, "depends_on");
    store.link(wo.id, openDep.id, "depends_on");

    // Order follows created_at, which ties within a millisecond — compare as a
    // set so the assertion is deterministic.
    const deps = workOrderDependencies(store, wo.id);
    expect(deps).toHaveLength(2);
    expect(deps).toEqual(
      expect.arrayContaining([
        { id: doneDep.id, title: "Done dep", status: "done" },
        { id: openDep.id, title: "Open dep", status: "ready" },
      ]),
    );
  });

  it("is empty for a work order with no dependencies", () => {
    const wo = store.createEntity({ type: "work_order", title: "Standalone", status: "ready" });
    expect(workOrderDependencies(store, wo.id)).toEqual([]);
  });
});
