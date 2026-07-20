import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkOrderStatus } from "../domain";
import { SqliteStore } from "../store/sqlite-store";
import { activityTimeline, knowledgeHealth, projectPulse } from "./pulse";

let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore(":memory:");
});
afterEach(() => {
  store.close();
});

const wo = (title: string, status: WorkOrderStatus) =>
  store.createEntity({ type: "work_order", title, status });

// requirement -> blueprint -> work orders, returning the pieces.
function feature(title: string, statuses: WorkOrderStatus[]) {
  const req = store.createEntity({ type: "requirement", title });
  const bp = store.createEntity({ type: "blueprint", title: `${title} bp` });
  store.link(bp.id, req.id, "details");
  const workOrders = statuses.map((s, i) => {
    const w = wo(`${title} wo${i}`, s);
    store.link(w.id, bp.id, "implements");
    return w;
  });
  return { req, bp, workOrders };
}

describe("projectPulse", () => {
  it("returns an all-zero pulse for an empty store", () => {
    const pulse = projectPulse(store);
    expect(pulse.counts).toEqual({ artifact: 0, requirement: 0, blueprint: 0, work_order: 0 });
    expect(pulse.workOrders.total).toBe(0);
    expect(pulse.workOrders.byStatus.ready).toBe(0);
    expect(pulse.completion).toBeNull();
    expect(pulse.features).toEqual([]);
    expect(pulse.criticalPath).toEqual([]);
    expect(pulse.blocked).toEqual([]);
    expect(pulse.now).toEqual({ inProgress: [], next: [] });
  });

  it("counts entities per type and work orders per status", () => {
    store.createEntity({ type: "artifact", title: "notes" });
    feature("F", ["done", "ready", "ready", "cancelled"]);

    const pulse = projectPulse(store);
    expect(pulse.counts).toEqual({ artifact: 1, requirement: 1, blueprint: 1, work_order: 4 });
    expect(pulse.workOrders.total).toBe(4);
    expect(pulse.workOrders.byStatus).toEqual({ draft: 0, ready: 2, in_progress: 0, done: 1, cancelled: 1 });
  });

  it("computes completion as done / non-cancelled and null when all work is cancelled", () => {
    feature("F", ["done", "done", "ready", "cancelled"]);
    expect(projectPulse(store).completion).toBeCloseTo(2 / 3);

    store = new SqliteStore(":memory:");
    feature("G", ["cancelled", "cancelled"]);
    expect(projectPulse(store).completion).toBeNull();
  });

  it("lists only root requirements as features, sorted by title then id", () => {
    const { req: rootB } = feature("beta", ["ready"]);
    const { req: rootA } = feature("alpha", ["done"]);
    const child = store.createEntity({ type: "requirement", title: "aaa child" });
    store.link(child.id, rootB.id, "child_of");

    const features = projectPulse(store).features;
    expect(features.map((f) => f.id)).toEqual([rootA.id, rootB.id]);
  });

  it("rolls a feature's progress and status counts up across its child_of subtree", () => {
    const { req: root } = feature("root", ["done"]);
    const { req: child, workOrders } = feature("child", ["ready", "in_progress"]);
    store.link(child.id, root.id, "child_of");
    void workOrders;
    // A sibling root keeps this a flat store — a LONE root with requirement
    // children would be a product root (Phase 14) and drop out of features.
    feature("sibling", []);

    const root_ = projectPulse(store).features.find((f) => f.id === root.id)!;
    expect(root_.progress).toBeCloseTo(1 / 3); // 1 done of 3 non-cancelled in the subtree
    expect(root_.workOrders).toEqual({ draft: 0, ready: 1, in_progress: 1, done: 1, cancelled: 0 });
  });

  it("leaves progress null for a feature with no non-cancelled work", () => {
    const { req } = feature("F", ["cancelled"]);
    const bare = store.createEntity({ type: "requirement", title: "bare" });

    const features = projectPulse(store).features;
    expect(features.find((f) => f.id === req.id)!.progress).toBeNull();
    expect(features.find((f) => f.id === bare.id)!.progress).toBeNull();
  });

  it("counts subtree gaps: requirements without blueprints and blueprints without work orders", () => {
    const root = store.createEntity({ type: "requirement", title: "root" }); // no bp -> gap
    const child = store.createEntity({ type: "requirement", title: "child" });
    store.link(child.id, root.id, "child_of");
    // Sibling root: keep the store flat so `root` stays a feature row (Phase 14).
    feature("sibling", []);
    const bp = store.createEntity({ type: "blueprint", title: "child bp" }); // no wo -> gap
    store.link(bp.id, child.id, "details");

    const f = projectPulse(store).features.find((x) => x.id === root.id)!;
    expect(f.gaps).toBe(2);
  });

  it("agrees with graphGaps: a feature blueprint covered by implemented child work is not a gap", () => {
    // Pulse counts the shared graphGaps result, so the descendant-coverage
    // exemption (2026-07-11) applies here exactly as on the X-ray badge.
    const product = store.createEntity({ type: "requirement", title: "Kiln" });
    const feat = store.createEntity({ type: "requirement", title: "feature" });
    store.link(feat.id, product.id, "child_of");
    const featBp = store.createEntity({ type: "blueprint", title: "feature bp" }); // no wo, covered below
    store.link(featBp.id, feat.id, "details");
    const phase = store.createEntity({ type: "requirement", title: "phase" });
    store.link(phase.id, feat.id, "child_of");
    const phaseBp = store.createEntity({ type: "blueprint", title: "phase bp" });
    store.link(phaseBp.id, phase.id, "details");
    const wo = store.createEntity({ type: "work_order", title: "W", status: "done" });
    store.link(wo.id, phaseBp.id, "implements");

    const f = projectPulse(store).features.find((x) => x.id === feat.id)!;
    expect(f.gaps).toBe(0);
  });

  it("counts a feature's ready-but-blocked work orders and lists them globally with blockers", () => {
    const { workOrders } = feature("F", ["ready", "in_progress"]);
    const [blockedWo, dep] = workOrders;
    store.link(blockedWo.id, dep.id, "depends_on");

    const pulse = projectPulse(store);
    expect(pulse.features[0].blocked).toBe(1);
    expect(pulse.blocked).toEqual([
      {
        id: blockedWo.id,
        title: blockedWo.title,
        blocking: [{ id: dep.id, title: dep.title, status: "in_progress" }],
      },
    ]);
  });

  it("does not report a ready work order whose dependencies are all done", () => {
    const { workOrders } = feature("F", ["ready", "done"]);
    store.link(workOrders[0].id, workOrders[1].id, "depends_on");

    const pulse = projectPulse(store);
    expect(pulse.blocked).toEqual([]);
    expect(pulse.features[0].blocked).toBe(0);
  });

  it("now: lists work in flight and the honest agent-pullable list", () => {
    const doing = wo("b doing", "in_progress");
    const doing2 = wo("a doing", "in_progress");
    const clean = wo("clean ready", "ready");
    const blocked = wo("blocked ready", "ready");
    const unfinishedDep = wo("dep", "in_progress");
    store.link(blocked.id, unfinishedDep.id, "depends_on");
    const unblocked = wo("unblocked ready", "ready");
    const doneDep = wo("done dep", "done");
    store.link(unblocked.id, doneDep.id, "depends_on");

    const { now } = projectPulse(store);
    // (title, id) ordering, and in_progress work is not in `next`.
    expect(now.inProgress.map((w) => w.id)).toEqual([doing2.id, doing.id, unfinishedDep.id]);
    // `next` = ready AND unblocked — the same rule as list_ready_work_orders.
    expect(now.next.map((w) => w.title)).toEqual(["clean ready", "unblocked ready"]);
    expect(now.next.map((w) => w.id)).not.toContain(blocked.id);
  });

  it("knowledgeHealth: returns an empty report for an empty store", () => {
    expect(knowledgeHealth(store)).toEqual({ workOrders: [], totals: { errors: 0, warns: 0, healthy: 0 } });
  });

  it("knowledgeHealth: covers only active work orders (done/cancelled excluded)", () => {
    wo("active", "ready");
    wo("finished", "done");
    wo("dropped", "cancelled");

    const report = knowledgeHealth(store);
    expect(report.workOrders.map((w) => w.title)).toEqual(["active"]);
    expect(report.workOrders[0].status).toBe("ready");
  });

  it("knowledgeHealth: sorts worst-first and counts healthy work orders", () => {
    // Fully wired: blueprint + requirement + non-empty artifact -> no warns.
    const { req, workOrders } = feature("healthy", ["in_progress"]);
    const art = store.createEntity({ type: "artifact", title: "notes", body: "real source material" });
    store.link(req.id, art.id, "references");
    const healthy = workOrders[0];

    // Wired but with an EMPTY artifact -> one warn (empty-artifact).
    const weak = feature("weak", ["ready"]);
    const empty = store.createEntity({ type: "artifact", title: "stub", body: "" });
    store.link(weak.req.id, empty.id, "references");

    // Bare work order: no blueprint, no requirement -> two warns.
    const bare = wo("bare", "draft");

    const report = knowledgeHealth(store);
    expect(report.workOrders.map((w) => w.id)).toEqual([bare.id, weak.workOrders[0].id, healthy.id]);
    expect(report.workOrders.map((w) => w.warns)).toEqual([2, 1, 0]);
    expect(report.totals).toEqual({ errors: 0, warns: 3, healthy: 1 });
    // The underlying checks ride along for the UI to render.
    expect(report.workOrders[0].checks.map((c) => c.code)).toContain("missing-blueprint");
    expect(report.workOrders[2].estTokens).toBeGreaterThan(0);
  });

  it("treats a null-status work order as draft everywhere (board convention)", () => {
    const bare = store.createEntity({ type: "work_order", title: "no status yet" });
    expect(bare.status).toBeNull();

    const pulse = projectPulse(store);
    expect(pulse.workOrders.byStatus.draft).toBe(1);
    expect(pulse.completion).toBe(0); // countable, not done

    const report = knowledgeHealth(store);
    expect(report.workOrders.map((w) => w.id)).toEqual([bare.id]);
    expect(report.workOrders[0].status).toBe("draft");
  });

  it("knowledgeHealth: breaks severity ties by title then id", () => {
    const b = wo("b same", "ready");
    const a = wo("a same", "ready");
    expect(knowledgeHealth(store).workOrders.map((w) => w.id)).toEqual([a.id, b.id]);
  });

  it("activityTimeline: returns nothing for an empty store", () => {
    expect(activityTimeline(store)).toEqual([]);
  });

  it("activityTimeline: merges created, revised, and handoff events newest-first", () => {
    const w = wo("W", "in_progress");
    store.saveContextReceipt({ id: "r-1", workOrderId: w.id, context: {}, hash: "h1", createdAt: "2020-01-01T00:00:00.000Z" });
    store.saveContextReceipt({ id: "r-2", workOrderId: w.id, context: {}, hash: "h2", createdAt: "2021-01-01T00:00:00.000Z" });
    store.commitBody(w.id, "new body");

    const events = activityTimeline(store);
    // Entity creation and the revision happen "now" (their relative order
    // depends on whether they share a millisecond); receipts are backdated.
    expect(events).toHaveLength(4);
    expect(new Set(events.slice(0, 2).map((e) => e.kind))).toEqual(new Set(["created", "revised"]));
    expect(events.map((e) => e.kind).slice(2)).toEqual(["handoff", "handoff"]);
    expect(events.map((e) => e.at).slice(2)).toEqual(["2021-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z"]);
    // Newest-first holds across the whole feed.
    for (let i = 1; i < events.length; i++) expect(events[i - 1].at >= events[i].at).toBe(true);
    expect(events.every((e) => e.entityId === w.id && e.entityType === "work_order" && e.title === "W")).toBe(true);
  });

  it("activityTimeline: breaks same-instant ties by kind then entityId", () => {
    const w = wo("W", "ready");
    // A handoff stamped at the exact creation instant: "created" sorts before "handoff".
    store.saveContextReceipt({ id: "r-1", workOrderId: w.id, context: {}, hash: "h", createdAt: w.createdAt });
    const kinds = activityTimeline(store).map((e) => e.kind);
    expect(kinds).toEqual(["created", "handoff"]);

    // Two same-instant handoffs on different work orders: entityId ascending.
    const w2 = wo("W2", "ready");
    const at = "2020-06-01T00:00:00.000Z";
    store.saveContextReceipt({ id: "r-2", workOrderId: w.id, context: {}, hash: "h2", createdAt: at });
    store.saveContextReceipt({ id: "r-3", workOrderId: w2.id, context: {}, hash: "h3", createdAt: at });
    const sameInstant = activityTimeline(store).filter((e) => e.at === at);
    expect(sameInstant.map((e) => e.entityId)).toEqual([w.id, w2.id].sort());
  });

  it("activityTimeline: truncates to the limit and defaults to 50", () => {
    for (let i = 0; i < 60; i++) store.createEntity({ type: "artifact", title: `a${i}` });
    expect(activityTimeline(store, 3)).toHaveLength(3);
    expect(activityTimeline(store)).toHaveLength(50);
    expect(activityTimeline(store, 0)).toEqual([]);
  });

  it("hydrates the critical path with titles and statuses in chain order", () => {
    const a = wo("a", "ready");
    const b = wo("b", "ready");
    const c = wo("c", "in_progress");
    store.link(a.id, b.id, "depends_on");
    store.link(b.id, c.id, "depends_on");

    expect(projectPulse(store).criticalPath).toEqual([
      { id: a.id, title: "a", status: "ready" },
      { id: b.id, title: "b", status: "ready" },
      { id: c.id, title: "c", status: "in_progress" },
    ]);
  });
});
