import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../store/sqlite-store";
import { graphSnapshot } from "./snapshot";

let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore(":memory:");
});
afterEach(() => {
  store.close();
});

describe("graphSnapshot", () => {
  it("returns every entity as a node and every link as a typed edge", () => {
    const art = store.createEntity({ type: "artifact", title: "Notes", body: "src" });
    const req = store.createEntity({ type: "requirement", title: "Feature" });
    const bp = store.createEntity({ type: "blueprint", title: "Design" });
    const wo = store.createEntity({ type: "work_order", title: "Build", status: "ready" });
    store.link(req.id, art.id, "references");
    store.link(bp.id, req.id, "details");
    store.link(wo.id, bp.id, "implements");

    const { nodes, edges } = graphSnapshot(store);
    expect(nodes.map((n) => n.id).sort()).toEqual([art.id, bp.id, req.id, wo.id].sort());
    // Nodes are ordered by pipeline stage: artifact, requirement, blueprint, work_order.
    expect(nodes.map((n) => n.type)).toEqual(["artifact", "requirement", "blueprint", "work_order"]);
    expect(edges).toContainEqual({ fromId: req.id, toId: art.id, type: "references" });
    expect(edges).toContainEqual({ fromId: bp.id, toId: req.id, type: "details" });
    expect(edges).toContainEqual({ fromId: wo.id, toId: bp.id, type: "implements" });
  });

  it("carries a work order's status and leaves its progress null", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "in_progress" });
    const node = graphSnapshot(store).nodes.find((n) => n.id === wo.id)!;
    expect(node.status).toBe("in_progress");
    expect(node.progress).toBeNull();
  });

  it("rolls up blueprint progress as done / non-cancelled work orders", () => {
    const bp = store.createEntity({ type: "blueprint", title: "BP" });
    const mk = (status: "done" | "ready" | "cancelled") =>
      store.link(store.createEntity({ type: "work_order", title: status, status }).id, bp.id, "implements");
    mk("done");
    mk("done");
    mk("ready");
    mk("cancelled"); // excluded from both sides

    const node = graphSnapshot(store).nodes.find((n) => n.id === bp.id)!;
    expect(node.progress).toBeCloseTo(2 / 3); // 2 done of 3 non-cancelled
  });

  it("rolls up requirement progress across the whole child_of subtree", () => {
    const root = store.createEntity({ type: "requirement", title: "root" });
    const child = store.createEntity({ type: "requirement", title: "child" });
    store.link(child.id, root.id, "child_of");
    const rootBp = store.createEntity({ type: "blueprint", title: "root bp" });
    const childBp = store.createEntity({ type: "blueprint", title: "child bp" });
    store.link(rootBp.id, root.id, "details");
    store.link(childBp.id, child.id, "details");
    // root's own blueprint: 1 done; child's blueprint: 1 not done.
    store.link(store.createEntity({ type: "work_order", title: "a", status: "done" }).id, rootBp.id, "implements");
    store.link(store.createEntity({ type: "work_order", title: "b", status: "ready" }).id, childBp.id, "implements");

    const nodes = graphSnapshot(store).nodes;
    // root sees both work orders (its subtree) -> 1 of 2 done.
    expect(nodes.find((n) => n.id === root.id)!.progress).toBeCloseTo(1 / 2);
    // child sees only its own -> 0 of 1.
    expect(nodes.find((n) => n.id === child.id)!.progress).toBe(0);
  });

  it("gives null progress to artifacts and to requirements/blueprints with no measurable work", () => {
    const art = store.createEntity({ type: "artifact", title: "A" });
    const req = store.createEntity({ type: "requirement", title: "empty req" });
    const bp = store.createEntity({ type: "blueprint", title: "empty bp" });
    store.link(bp.id, req.id, "details");
    // Only a cancelled work order -> nothing countable.
    store.link(store.createEntity({ type: "work_order", title: "x", status: "cancelled" }).id, bp.id, "implements");

    const nodes = graphSnapshot(store).nodes;
    expect(nodes.find((n) => n.id === art.id)!.progress).toBeNull();
    expect(nodes.find((n) => n.id === req.id)!.progress).toBeNull();
    expect(nodes.find((n) => n.id === bp.id)!.progress).toBeNull();
  });

  it("is deterministic — reruns are byte-identical", () => {
    const req = store.createEntity({ type: "requirement", title: "R" });
    const bp = store.createEntity({ type: "blueprint", title: "B" });
    store.link(bp.id, req.id, "details");
    store.createEntity({ type: "artifact", title: "A" });

    expect(JSON.stringify(graphSnapshot(store))).toBe(JSON.stringify(graphSnapshot(store)));
  });

  it("is empty for an empty store", () => {
    expect(graphSnapshot(store)).toEqual({ nodes: [], edges: [] });
  });
});
