import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedProject } from "../seed";
import { SqliteStore } from "../store/sqlite-store";
import { projectShape } from "./shape";

let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore(":memory:");
});
afterEach(() => {
  store.close();
});

const pendingSuggestion = (targetId: string) => ({
  id: crypto.randomUUID(),
  targetId,
  source: "extract_agent" as const,
  ops: [{ kind: "insert" as const, anchor: "", text: "hello" }],
});

describe("projectShape", () => {
  it("an unseeded store is empty", () => {
    expect(projectShape(store)).toEqual({
      shape: "empty",
      rootTitle: null,
      counts: { requirements: 0, blueprints: 0, workOrders: 0, artifacts: 0 },
      pendingSuggestions: 0,
    });
  });

  it("a freshly seeded project is fresh, with the root title and seeded counts", () => {
    seedProject(store, "Demo");
    expect(projectShape(store)).toEqual({
      shape: "fresh",
      rootTitle: "Demo",
      counts: { requirements: 1, blueprints: 1, workOrders: 0, artifacts: 0 },
      pendingSuggestions: 0,
    });
  });

  it("a graph with features and work is populated", () => {
    const { root } = seedProject(store, "Demo");
    const req = store.createEntity({ type: "requirement", title: "F — does things" });
    store.link(req.id, root.id, "child_of");
    const bp = store.createEntity({ type: "blueprint", title: "F bp" });
    store.link(bp.id, req.id, "details");
    const wo = store.createEntity({ type: "work_order", title: "wo", status: "ready" });
    store.link(wo.id, bp.id, "implements");
    store.createEntity({ type: "artifact", title: "evidence", body: "x" });

    expect(projectShape(store)).toEqual({
      shape: "populated",
      rootTitle: "Demo",
      counts: { requirements: 2, blueprints: 2, workOrders: 1, artifacts: 1 },
      pendingSuggestions: 0,
    });
  });

  it("an edited root body flips a seeded project to populated", () => {
    const { root } = seedProject(store, "Demo");
    store.updateEntity(root.id, { body: "## Overview\nHand-written." });
    expect(projectShape(store).shape).toBe("populated");
  });

  it("a pending suggestion on the seeded pair flips it to populated (and is counted)", () => {
    const { root } = seedProject(store, "Demo");
    store.saveSuggestion(pendingSuggestion(root.id));
    const shape = projectShape(store);
    expect(shape.shape).toBe("populated");
    expect(shape.pendingSuggestions).toBe(1);
  });

  it("several parentless requirements report no single root title", () => {
    seedProject(store, "Demo");
    store.createEntity({ type: "requirement", title: "Stray root" });
    const shape = projectShape(store);
    expect(shape.shape).toBe("populated");
    expect(shape.rootTitle).toBeNull();
  });
});
