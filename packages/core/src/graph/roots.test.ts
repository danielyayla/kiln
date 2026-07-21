import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkOrderStatus } from "../domain";
import { SqliteStore } from "../store/sqlite-store";
import { projectPulse } from "./pulse";
import { featureRoots, productRoot, rootRequirements } from "./roots";
import { descendantWorkOrders, rollup } from "./snapshot";

let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore(":memory:");
});
afterEach(() => {
  store.close();
});

// requirement -> blueprint -> work orders, optionally under a parent.
function feature(title: string, statuses: WorkOrderStatus[], parentId?: string) {
  const req = store.createEntity({ type: "requirement", title });
  if (parentId) store.link(req.id, parentId, "child_of");
  const bp = store.createEntity({ type: "blueprint", title: `${title} bp` });
  store.link(bp.id, req.id, "details");
  const workOrders = statuses.map((s, i) => {
    const w = store.createEntity({ type: "work_order", title: `${title} wo${i}`, status: s });
    store.link(w.id, bp.id, "implements");
    return w;
  });
  return { req, bp, workOrders };
}

describe("product-root convention", () => {
  it("a flat store has no product root and features = the roots themselves", () => {
    const { req: a } = feature("alpha", ["done"]);
    const { req: b } = feature("beta", ["ready"]);

    expect(productRoot(store)).toBeNull();
    expect(featureRoots(store).map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(rootRequirements(store)).toHaveLength(2);
  });

  it("a single root with requirement children is the product root; features = its children", () => {
    const product = store.createEntity({ type: "requirement", title: "Kiln" });
    const { req: a } = feature("alpha", ["done"], product.id);
    const { req: b } = feature("beta", ["ready"], product.id);

    expect(productRoot(store)?.id).toBe(product.id);
    const features = featureRoots(store);
    expect(features.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect(features.map((r) => r.id)).not.toContain(product.id);
  });

  it("a lone requirement with sub-requirements counts as a product root (accepted edge)", () => {
    const lone = store.createEntity({ type: "requirement", title: "only feature" });
    const sub = store.createEntity({ type: "requirement", title: "sub" });
    store.link(sub.id, lone.id, "child_of");

    expect(productRoot(store)?.id).toBe(lone.id);
    expect(featureRoots(store).map((r) => r.id)).toEqual([sub.id]);
  });

  it("two parentless requirements mean no product root, even if one has children", () => {
    const a = store.createEntity({ type: "requirement", title: "a" });
    const b = store.createEntity({ type: "requirement", title: "b" });
    const child = store.createEntity({ type: "requirement", title: "child" });
    store.link(child.id, a.id, "child_of");

    expect(productRoot(store)).toBeNull();
    expect(featureRoots(store).map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("a childless root with a details blueprint is the product root (fresh seeded project)", () => {
    // Same shape seedProject() creates: root requirement + design-doc blueprint.
    const root = store.createEntity({ type: "requirement", title: "New project" });
    const doc = store.createEntity({ type: "blueprint", title: "New project system architecture" });
    store.link(doc.id, root.id, "details");

    expect(productRoot(store)?.id).toBe(root.id);
    expect(featureRoots(store)).toEqual([]);
  });

  it("a childless root with no details blueprint is a plain feature, not a product root", () => {
    const req = store.createEntity({ type: "requirement", title: "solo" });
    const wo = store.createEntity({ type: "work_order", title: "wo" });
    store.link(wo.id, req.id, "implements");

    expect(productRoot(store)).toBeNull();
    expect(featureRoots(store).map((r) => r.id)).toEqual([req.id]);
  });

  it("a solo feature with a details blueprint reads as a product root (accepted edge)", () => {
    // Shape-indistinguishable from a fresh seeded project; self-heals when a
    // second root appears.
    const { req } = feature("solo", ["ready"]);
    expect(productRoot(store)?.id).toBe(req.id);
    expect(featureRoots(store)).toEqual([]);
  });

  it("non-requirement children do not make a root a product root", () => {
    const root = store.createEntity({ type: "requirement", title: "root" });
    const art = store.createEntity({ type: "artifact", title: "notes" });
    store.link(art.id, root.id, "child_of");

    expect(productRoot(store)).toBeNull();
  });
});

describe("projectPulse with a product root", () => {
  it("lists the product root's children as features and never the root itself", () => {
    const product = store.createEntity({ type: "requirement", title: "Kiln" });
    feature("beta", ["ready"], product.id);
    feature("alpha", ["done"], product.id);

    const features = projectPulse(store).features;
    expect(features.map((f) => f.title)).toEqual(["alpha", "beta"]);
  });

  it("overall completion equals the product root's rollup in a migrated store", () => {
    const product = store.createEntity({ type: "requirement", title: "Kiln" });
    feature("alpha", ["done", "done"], product.id);
    feature("beta", ["ready", "cancelled"], product.id);

    const pulse = projectPulse(store);
    expect(pulse.completion).toBeCloseTo(2 / 3);
    // Every work order hangs under the root, so the KPI and the root's
    // rollup are the same number — asserted, not re-derived (BP-14 §1).
    expect(pulse.completion).toBeCloseTo(rollup(descendantWorkOrders(store, product))!);
  });
});
