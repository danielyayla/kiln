import { describe, expect, it } from "vitest";
import {
  assembleWorkOrderContext,
  blockingDependencies,
  readyWorkOrders,
  SqliteStore,
} from "@kiln/core";
import { seed } from "./seed.js";

describe("seed", () => {
  it("inserts a fully linked chain with a ready work order", () => {
    const store = new SqliteStore(":memory:");
    try {
      const chain = seed(store);

      const workOrder = store.getEntity(chain.workOrderId);
      expect(workOrder?.type).toBe("work_order");
      expect(workOrder?.status).toBe("ready");

      // The ready work order is discoverable by status.
      const ready = store.workOrdersByStatus("ready");
      expect(ready.map((w) => w.id)).toContain(chain.workOrderId);

      // The whole intent chain reassembles from the work order.
      const ctx = assembleWorkOrderContext(store, chain.workOrderId);
      expect(ctx.blueprint?.id).toBe(chain.blueprintId);
      expect(ctx.requirement?.id).toBe(chain.requirementId);
      expect(ctx.artifacts.map((a) => a.id)).toEqual([chain.artifactId]);
    } finally {
      store.close();
    }
  });

  it("seeds a richer graph: nested requirement, second feature, spread statuses", () => {
    const store = new SqliteStore(":memory:");
    try {
      const chain = seed(store);

      // Nested sub-requirement hangs off the primary requirement.
      const children = store.children(chain.requirementId);
      expect(children.map((c) => c.title)).toContain("Agent status reporting");

      // Work orders land in multiple board columns. Two are `ready` by
      // status, but only ONE is unblocked — list_ready_work_orders offers
      // exactly the primary chain's order (tools.test relies on that).
      expect(store.workOrdersByStatus("ready")).toHaveLength(2);
      expect(readyWorkOrders(store).map((w) => w.id)).toEqual([chain.workOrderId]);
      expect(store.workOrdersByStatus("draft").length).toBeGreaterThan(0);
      expect(store.workOrdersByStatus("in_progress").length).toBeGreaterThan(0);
      expect(store.workOrdersByStatus("done").length).toBeGreaterThan(0);

      // The second feature has its own artifact → requirement → blueprint chain.
      const editorReq = store
        .listEntities("requirement")
        .find((e) => e.title === "Robust document editing");
      expect(editorReq).toBeTruthy();
      expect(store.linked(editorReq!.id, "references").map((a) => a.title)).toContain(
        "Editor feedback notes",
      );
      expect(store.linkedFrom(editorReq!.id, "details").map((b) => b.title)).toContain(
        "Editor autosave & recovery",
      );

      // depends_on edge between the editor work orders.
      const recovery = store
        .listEntities("work_order")
        .find((e) => e.title === "Recover unsaved changes on relaunch");
      expect(store.linked(recovery!.id, "depends_on").map((w) => w.title)).toEqual([
        "Autosave document drafts",
      ]);

      // The ready-but-BLOCKED pair: the history work order is `ready` but
      // depends on the (in_progress) recovery work — so readiness filtering
      // and the board's blocked badge are demonstrable from a fresh seed.
      const history = store
        .listEntities("work_order")
        .find((e) => e.title === "Browse and restore revision history");
      expect(history?.status).toBe("ready");
      expect(blockingDependencies(store, history!.id).map((w) => w.id)).toEqual([recovery!.id]);
      expect(readyWorkOrders(store).map((w) => w.id)).not.toContain(history!.id);
    } finally {
      store.close();
    }
  });

  it("is idempotent: re-seeding re-uses entities instead of duplicating them", () => {
    const store = new SqliteStore(":memory:");
    try {
      const first = seed(store);
      const counts = {
        artifact: store.listEntities("artifact").length,
        requirement: store.listEntities("requirement").length,
        blueprint: store.listEntities("blueprint").length,
        work_order: store.listEntities("work_order").length,
      };

      const second = seed(store);

      expect(second).toEqual(first);
      expect(store.listEntities("artifact")).toHaveLength(counts.artifact);
      expect(store.listEntities("requirement")).toHaveLength(counts.requirement);
      expect(store.listEntities("blueprint")).toHaveLength(counts.blueprint);
      expect(store.listEntities("work_order")).toHaveLength(counts.work_order);
      // Still two ready by status — and exactly one unblocked.
      expect(store.workOrdersByStatus("ready")).toHaveLength(2);
      expect(readyWorkOrders(store)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("re-seeding does not disturb entities the user has since edited or re-linked", () => {
    const store = new SqliteStore(":memory:");
    try {
      const chain = seed(store);

      // User repoints the blueprint at their own requirement.
      const otherReq = store.createEntity({ type: "requirement", title: "My own feature" });
      store.unlink(chain.blueprintId, chain.requirementId, "details");
      store.link(chain.blueprintId, otherReq.id, "details");

      seed(store);

      // The user's re-link survives (details is 1:1 — seed must not fight it).
      expect(store.linked(chain.blueprintId, "details").map((r) => r.id)).toEqual([otherReq.id]);
    } finally {
      store.close();
    }
  });
});
