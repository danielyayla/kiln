import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../store/sqlite-store";
import { ancestors, assembleWorkOrderContext, descendants } from "./context";

let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore(":memory:");
});
afterEach(() => {
  store.close();
});

function seedChain() {
  const artifact = store.createEntity({ type: "artifact", title: "Interview", body: "notes" });
  const requirement = store.createEntity({ type: "requirement", title: "Track miles" });
  const blueprint = store.createEntity({ type: "blueprint", title: "Mileage BP" });
  const workOrder = store.createEntity({ type: "work_order", title: "Implement backend", status: "ready" });
  store.link(requirement.id, artifact.id, "references");
  store.link(blueprint.id, requirement.id, "details");
  store.link(workOrder.id, blueprint.id, "implements");
  return { artifact, requirement, blueprint, workOrder };
}

describe("assembleWorkOrderContext", () => {
  it("assembles the full linked chain in one call", () => {
    const { artifact, requirement, blueprint, workOrder } = seedChain();
    const ctx = assembleWorkOrderContext(store, workOrder.id);
    expect(ctx.workOrder.id).toBe(workOrder.id);
    expect(ctx.blueprint?.id).toBe(blueprint.id);
    expect(ctx.requirement?.id).toBe(requirement.id);
    expect(ctx.artifacts.map((a) => a.id)).toEqual([artifact.id]);
  });

  it("returns typed partials when links are missing", () => {
    const wo = store.createEntity({ type: "work_order", title: "orphan", status: "ready" });
    const ctx = assembleWorkOrderContext(store, wo.id);
    expect(ctx.blueprint).toBeNull();
    expect(ctx.requirement).toBeNull();
    expect(ctx.artifacts).toEqual([]);
  });

  it("throws for an unknown work order", () => {
    expect(() => assembleWorkOrderContext(store, "does-not-exist")).toThrow();
  });

  it("has an empty lineage for a flat store (no child_of) — output unchanged", () => {
    const { workOrder } = seedChain();
    expect(assembleWorkOrderContext(store, workOrder.id).lineage).toEqual([]);
  });
});

describe("assembleWorkOrderContext — ancestor lineage (Phase 6)", () => {
  // root(A_root) <- mid(A_mid) <- leaf(A_leaf, A_root) ; blueprint details leaf.
  // leaf re-references A_root to exercise nearest-wins dedup.
  function seedNested() {
    const aRoot = store.createEntity({ type: "artifact", title: "Root PRD", body: "why" });
    const aMid = store.createEntity({ type: "artifact", title: "Mid notes", body: "mid" });
    const aLeaf = store.createEntity({ type: "artifact", title: "Leaf spec", body: "leaf" });
    const root = store.createEntity({ type: "requirement", title: "root req" });
    const mid = store.createEntity({ type: "requirement", title: "mid req" });
    const leaf = store.createEntity({ type: "requirement", title: "leaf req" });
    const blueprint = store.createEntity({ type: "blueprint", title: "BP" });
    const workOrder = store.createEntity({ type: "work_order", title: "WO", status: "ready" });
    store.link(mid.id, root.id, "child_of");
    store.link(leaf.id, mid.id, "child_of");
    store.link(root.id, aRoot.id, "references");
    store.link(mid.id, aMid.id, "references");
    store.link(leaf.id, aLeaf.id, "references");
    store.link(leaf.id, aRoot.id, "references"); // shared with root — nearest (leaf) wins
    store.link(blueprint.id, leaf.id, "details");
    store.link(workOrder.id, blueprint.id, "implements");
    return { aRoot, aMid, aLeaf, root, mid, leaf, workOrder };
  }

  it("folds ancestor artifacts in nearest-first order with nearest-wins dedup", () => {
    const { aRoot, aMid, aLeaf, root, mid, workOrder } = seedNested();
    const ctx = assembleWorkOrderContext(store, workOrder.id);

    // Level 0 (the work order's own requirement) is unchanged.
    expect(ctx.artifacts.map((a) => a.id).sort()).toEqual([aLeaf.id, aRoot.id].sort());

    // Lineage is nearest-first: mid then root.
    expect(ctx.lineage.map((l) => l.requirement.id)).toEqual([mid.id, root.id]);
    // mid contributes its own artifact; root contributes nothing because its
    // only artifact (A_root) already appeared nearer, at the leaf (level 0).
    expect(ctx.lineage[0].artifacts.map((a) => a.id)).toEqual([aMid.id]);
    expect(ctx.lineage[1].artifacts).toEqual([]);
  });

  it("carries each ancestor's details blueprint when one exists (Phase 14)", () => {
    const { root, mid, workOrder } = seedNested();
    const rootBp = store.createEntity({ type: "blueprint", title: "Architecture overview" });
    store.link(rootBp.id, root.id, "details");

    const lineage = assembleWorkOrderContext(store, workOrder.id).lineage;
    expect(lineage.map((l) => l.requirement.id)).toEqual([mid.id, root.id]);
    // mid has no details blueprint — the key is absent, not null.
    expect("blueprint" in lineage[0]).toBe(false);
    expect(lineage[1].blueprint?.id).toBe(rootBp.id);
  });

  it("resolves multiple details blueprints deterministically — first by (title, id)", () => {
    const { root, workOrder } = seedNested();
    const b = store.createEntity({ type: "blueprint", title: "b overview" });
    const a = store.createEntity({ type: "blueprint", title: "a overview" });
    store.link(b.id, root.id, "details");
    store.link(a.id, root.id, "details");

    const lineage = assembleWorkOrderContext(store, workOrder.id).lineage;
    expect(lineage[1].blueprint?.id).toBe(a.id);
  });

  it("is cycle-safe (inherited from ancestors) — no infinite loop", () => {
    const a = store.createEntity({ type: "requirement", title: "a" });
    const b = store.createEntity({ type: "requirement", title: "b" });
    const blueprint = store.createEntity({ type: "blueprint", title: "BP" });
    const workOrder = store.createEntity({ type: "work_order", title: "WO", status: "ready" });
    store.link(a.id, b.id, "child_of");
    store.link(b.id, a.id, "child_of"); // cycle
    store.link(blueprint.id, a.id, "details");
    store.link(workOrder.id, blueprint.id, "implements");

    const ctx = assembleWorkOrderContext(store, workOrder.id);
    // The cycle is broken by the ancestors() seen-set; lineage stays finite.
    expect(ctx.lineage.length).toBeLessThanOrEqual(1);
  });
});

describe("feature-tree traversal", () => {
  it("walks ancestors and descendants", () => {
    const root = store.createEntity({ type: "requirement", title: "root" });
    const mid = store.createEntity({ type: "requirement", title: "mid" });
    const leaf = store.createEntity({ type: "requirement", title: "leaf" });
    store.link(mid.id, root.id, "child_of");
    store.link(leaf.id, mid.id, "child_of");
    expect(ancestors(store, leaf.id).map((e) => e.title)).toEqual(["mid", "root"]);
    expect(descendants(store, root.id).map((e) => e.title).sort()).toEqual(["leaf", "mid"]);
  });
});
