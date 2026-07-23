import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedProject } from "../seed";
import { SqliteStore } from "../store/sqlite-store";
import { proposeFeature } from "./proposal";
import { pendingProposals } from "./review-queue";

let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore(":memory:");
});
afterEach(() => {
  store.close();
});

const feature = (n: number) => ({
  requirement: { title: `F${n} — does thing ${n}`, body: `## Capability\nx\n\n## Non-goals\n- y` },
  blueprint: { title: `F${n} bp`, body: "## Approach\nz" },
  evidence: [{ title: `F${n} evidence`, body: "excerpt" }],
});

describe("pendingProposals", () => {
  it("returns nothing for a store without pending suggestions", () => {
    seedProject(store, "Demo");
    expect(pendingProposals(store)).toEqual([]);
  });

  it("pairs a proposed feature's requirement and blueprint, requirement first", () => {
    const { root } = seedProject(store, "Demo");
    const ids = proposeFeature(store, root.id, feature(1));

    const groups = pendingProposals(store);
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe("F1 — does thing 1");
    expect(groups[0].items.map((i) => [i.entityType, i.entityId])).toEqual([
      ["requirement", ids.requirementId],
      ["blueprint", ids.blueprintId],
    ]);
    expect(groups[0].items[0].suggestionId).toBe(ids.requirementSuggestionId);
    expect(groups[0].items[0].opCount).toBeGreaterThan(0);
    expect(groups[0].items[0].source).toBe("extract_agent");
  });

  it("orders groups by the anchor requirement's creation (survey tree order)", () => {
    const { root } = seedProject(store, "Demo");
    proposeFeature(store, root.id, feature(1));
    proposeFeature(store, root.id, feature(2));
    proposeFeature(store, root.id, feature(3));

    expect(pendingProposals(store).map((g) => g.title)).toEqual([
      "F1 — does thing 1",
      "F2 — does thing 2",
      "F3 — does thing 3",
    ]);
  });

  it("a blueprint whose requirement was already resolved still groups under it", () => {
    const { root } = seedProject(store, "Demo");
    const ids = proposeFeature(store, root.id, feature(1));
    // Resolve the requirement's suggestion (dismiss); the blueprint's remains.
    const reqSuggestion = store.listSuggestions(ids.requirementId)[0];
    store.deleteSuggestion(reqSuggestion.id);

    const groups = pendingProposals(store);
    expect(groups).toHaveLength(1);
    expect(groups[0].title).toBe("F1 — does thing 1");
    expect(groups[0].items.map((i) => i.entityId)).toEqual([ids.blueprintId]);
  });

  it("suggestions on unlinked entities stand alone, after nothing in particular", () => {
    const { root } = seedProject(store, "Demo");
    const wo = store.createEntity({ type: "work_order", title: "loose wo" });
    store.saveSuggestion({
      id: crypto.randomUUID(),
      targetId: wo.id,
      source: "review_agent",
      ops: [{ kind: "insert", anchor: "", text: "body" }],
    });
    store.saveSuggestion({
      id: crypto.randomUUID(),
      targetId: root.id,
      source: "human",
      ops: [{ kind: "insert", anchor: "", text: "overview" }],
    });

    const groups = pendingProposals(store);
    expect(groups).toHaveLength(2);
    // Root requirement was created before the work order.
    expect(groups[0].title).toBe("Demo");
    expect(groups[0].items[0].source).toBe("human");
    expect(groups[1].title).toBe("loose wo");
    expect(groups[1].items[0].entityType).toBe("work_order");
  });
});
