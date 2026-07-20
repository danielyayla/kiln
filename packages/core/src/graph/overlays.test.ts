import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../store/sqlite-store";
import { criticalPath, graphGaps } from "./overlays";

let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore(":memory:");
});
afterEach(() => {
  store.close();
});

describe("graphGaps", () => {
  it("finds requirements with no blueprint, blueprints with no work order, artifacts referenced by nothing", () => {
    // A complete chain — nothing here is a gap.
    const art = store.createEntity({ type: "artifact", title: "used art" });
    const req = store.createEntity({ type: "requirement", title: "detailed req" });
    const bp = store.createEntity({ type: "blueprint", title: "implemented bp" });
    const wo = store.createEntity({ type: "work_order", title: "WO", status: "ready" });
    store.link(req.id, art.id, "references");
    store.link(bp.id, req.id, "details");
    store.link(wo.id, bp.id, "implements");

    // The gaps.
    const looseReq = store.createEntity({ type: "requirement", title: "no bp" });
    const looseBp = store.createEntity({ type: "blueprint", title: "no wo" });
    const looseArt = store.createEntity({ type: "artifact", title: "unreferenced" });

    const gaps = graphGaps(store);
    expect(gaps.requirements).toEqual([looseReq.id]);
    expect(gaps.blueprints).toEqual([looseBp.id]);
    expect(gaps.artifacts).toEqual([looseArt.id]);
  });

  it("returns empty arrays when the graph is fully linked", () => {
    const art = store.createEntity({ type: "artifact", title: "A" });
    const req = store.createEntity({ type: "requirement", title: "R" });
    const bp = store.createEntity({ type: "blueprint", title: "B" });
    const wo = store.createEntity({ type: "work_order", title: "W", status: "ready" });
    store.link(req.id, art.id, "references");
    store.link(bp.id, req.id, "details");
    store.link(wo.id, bp.id, "implements");
    expect(graphGaps(store)).toEqual({ requirements: [], blueprints: [], artifacts: [] });
  });

  it("exempts the product root's architecture blueprint, but still flags a bare feature (Phase 16)", () => {
    // Migrated shape: root <- feature; the root's details blueprint has no
    // work orders BY DESIGN (it is reference material, not a pipeline stage).
    const root = store.createEntity({ type: "requirement", title: "Kiln" });
    const arch = store.createEntity({ type: "blueprint", title: "Architecture" });
    store.link(arch.id, root.id, "details");
    const feature = store.createEntity({ type: "requirement", title: "bare feature" }); // no bp -> a real gap
    store.link(feature.id, root.id, "child_of");

    const gaps = graphGaps(store);
    expect(gaps.blueprints).toEqual([]); // arch exempt
    expect(gaps.requirements).toEqual([feature.id]); // the real gap survives
  });

  it("exempts a blueprint-less product root from the requirement rule (Phase 16)", () => {
    const root = store.createEntity({ type: "requirement", title: "Kiln" }); // no details bp
    const feature = store.createEntity({ type: "requirement", title: "feature" });
    store.link(feature.id, root.id, "child_of");
    const bp = store.createEntity({ type: "blueprint", title: "feature bp" });
    store.link(bp.id, feature.id, "details");
    const wo = store.createEntity({ type: "work_order", title: "W", status: "ready" });
    store.link(wo.id, bp.id, "implements");

    // The root is not flagged; contextHealth's missing-architecture warning
    // is the surface that owns "the root SHOULD have one".
    expect(graphGaps(store).requirements).toEqual([]);
  });

  it("exempts a feature-level blueprint whose child requirements carry the implemented work", () => {
    // The phases-into-features shape (2026-07-11): feature <- phase child; the
    // feature's design doc has no direct work orders, but the phase blueprint
    // nested under it is implemented — the feature is built, not a gap.
    const root = store.createEntity({ type: "requirement", title: "Kiln" });
    const feature = store.createEntity({ type: "requirement", title: "X-ray" });
    store.link(feature.id, root.id, "child_of");
    const featureBp = store.createEntity({ type: "blueprint", title: "X-ray design" }); // no wo
    store.link(featureBp.id, feature.id, "details");
    const phase = store.createEntity({ type: "requirement", title: "Phase 12" });
    store.link(phase.id, feature.id, "child_of");
    const phaseBp = store.createEntity({ type: "blueprint", title: "BP-12" });
    store.link(phaseBp.id, phase.id, "details");
    const wo = store.createEntity({ type: "work_order", title: "W", status: "done" });
    store.link(wo.id, phaseBp.id, "implements");

    expect(graphGaps(store).blueprints).toEqual([]);
  });

  it("still flags an uncovered blueprint on a childless requirement (historical shell)", () => {
    const root = store.createEntity({ type: "requirement", title: "Kiln" });
    const feature = store.createEntity({ type: "requirement", title: "feature" });
    store.link(feature.id, root.id, "child_of");
    const shell = store.createEntity({ type: "requirement", title: "Phase 5 shell" });
    store.link(shell.id, feature.id, "child_of");
    const shellBp = store.createEntity({ type: "blueprint", title: "Phase 5 foundation" }); // no wo, no children below
    store.link(shellBp.id, shell.id, "details");
    // Keep the feature itself out of the requirement gaps.
    const featureBp = store.createEntity({ type: "blueprint", title: "feature bp" });
    store.link(featureBp.id, feature.id, "details");
    const wo = store.createEntity({ type: "work_order", title: "W", status: "done" });
    store.link(wo.id, featureBp.id, "implements");

    expect(graphGaps(store).blueprints).toEqual([shellBp.id]);
  });

  it("exempts a freshly seeded root's design doc before it has feature children", () => {
    // The Projects seed shape: a lone parentless requirement with its design-doc
    // blueprint and nothing else. The design doc is reference material, not a
    // pipeline stage — no gap, even though the root has no feature children yet.
    const root = store.createEntity({ type: "requirement", title: "Test" });
    const design = store.createEntity({ type: "blueprint", title: "Test system architecture" });
    store.link(design.id, root.id, "details");

    const gaps = graphGaps(store);
    expect(gaps.blueprints).toEqual([]);
    expect(gaps.requirements).toEqual([]);
  });

  it("is not exempted by a sibling blueprint on the same requirement (descendants only)", () => {
    // R is a FEATURE (child of the product root), not the root itself — so its
    // sibling design-doc blueprint is a genuine pipeline gap, unlike a root doc.
    const root = store.createEntity({ type: "requirement", title: "Kiln" });
    const req = store.createEntity({ type: "requirement", title: "R" });
    store.link(req.id, root.id, "child_of");
    const built = store.createEntity({ type: "blueprint", title: "built bp" });
    const doc = store.createEntity({ type: "blueprint", title: "doc bp" }); // no wo
    store.link(built.id, req.id, "details");
    store.link(doc.id, req.id, "details");
    const wo = store.createEntity({ type: "work_order", title: "W", status: "done" });
    store.link(wo.id, built.id, "implements");

    expect(graphGaps(store).blueprints).toEqual([doc.id]);
  });

  it("keeps flagging root docs in a flat store, where no product root exists (Phase 16)", () => {
    const a = store.createEntity({ type: "requirement", title: "a" }); // no bp
    const b = store.createEntity({ type: "requirement", title: "b" });
    const bBp = store.createEntity({ type: "blueprint", title: "b bp" }); // no wo
    store.link(bBp.id, b.id, "details");

    const gaps = graphGaps(store);
    expect(gaps.requirements).toEqual([a.id]);
    expect(gaps.blueprints).toEqual([bBp.id]);
  });
});

describe("criticalPath", () => {
  // Chain a -> b -> c (each depends_on the next), plus a shorter branch.
  function chain() {
    const a = store.createEntity({ type: "work_order", title: "a", status: "ready" });
    const b = store.createEntity({ type: "work_order", title: "b", status: "ready" });
    const c = store.createEntity({ type: "work_order", title: "c", status: "ready" });
    const d = store.createEntity({ type: "work_order", title: "d", status: "ready" });
    store.link(a.id, b.id, "depends_on");
    store.link(b.id, c.id, "depends_on");
    store.link(d.id, c.id, "depends_on"); // shorter branch d -> c
    return { a, b, c, d };
  }

  it("returns the longest depends_on chain among unfinished work orders", () => {
    const { a, b, c } = chain();
    expect(criticalPath(store)).toEqual([a.id, b.id, c.id]);
  });

  it("excludes done/cancelled work orders from the path", () => {
    const { a, c } = chain();
    store.updateEntity(a.id, { status: "in_progress" });
    store.updateEntity(a.id, { status: "done" }); // a is finished, so it drops out of the path
    // Without a, the two remaining chains (b→c and d→c) tie at length 2; the
    // exact head is a deterministic id-tie-break, so assert the invariants.
    const path = criticalPath(store);
    expect(path).toHaveLength(2);
    expect(path[1]).toBe(c.id);
    expect(path).not.toContain(a.id);
  });

  it("is empty when there are no unfinished dependency chains", () => {
    const solo = store.createEntity({ type: "work_order", title: "solo", status: "ready" });
    expect(criticalPath(store)).toEqual([solo.id]); // a single node is a length-1 path
    store.updateEntity(solo.id, { status: "in_progress" });
    store.updateEntity(solo.id, { status: "done" });
    expect(criticalPath(store)).toEqual([]); // nothing unfinished
  });

  it("terminates on a depends_on cycle", () => {
    const x = store.createEntity({ type: "work_order", title: "x", status: "ready" });
    const y = store.createEntity({ type: "work_order", title: "y", status: "ready" });
    store.link(x.id, y.id, "depends_on");
    store.link(y.id, x.id, "depends_on"); // cycle
    const path = criticalPath(store);
    expect(path.length).toBeGreaterThan(0);
    expect(path.length).toBeLessThanOrEqual(2); // does not loop forever
  });
});
