import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../store";
import { featureTree } from "./tree";

let store: SqliteStore;

beforeEach(() => {
  store = new SqliteStore(":memory:");
});
afterEach(() => store.close());

function req(title: string, parentId?: string) {
  const e = store.createEntity({ type: "requirement", title });
  if (parentId) store.link(e.id, parentId, "child_of");
  return e;
}

describe("featureTree", () => {
  it("returns an empty forest for an empty store", () => {
    expect(featureTree(store)).toEqual([]);
  });

  it("nests requirements by child_of and keeps non-parents as roots", () => {
    const root1 = req("Root 1");
    const child = req("Child", root1.id);
    const grandchild = req("Grandchild", child.id);
    const root2 = req("Root 2");

    const tree = featureTree(store);
    expect(tree.map((n) => n.entity.id)).toEqual([root1.id, root2.id]);
    expect(tree[0].children.map((n) => n.entity.id)).toEqual([child.id]);
    expect(tree[0].children[0].children.map((n) => n.entity.id)).toEqual([grandchild.id]);
    expect(tree[1].children).toEqual([]);
  });

  it("excludes non-requirement entities from the tree", () => {
    const root = req("Root");
    store.createEntity({ type: "artifact", title: "A" });
    const blueprint = store.createEntity({ type: "blueprint", title: "B" });
    // A stray child_of edge from a blueprint must not surface in the tree.
    store.link(blueprint.id, root.id, "child_of");

    const tree = featureTree(store);
    expect(tree).toHaveLength(1);
    expect(tree[0].children).toEqual([]);
  });

  it("survives a child_of cycle without recursing forever", () => {
    const a = req("A");
    const b = req("B", a.id);
    // Cycle: a is also a child of b.
    store.link(a.id, b.id, "child_of");

    // Neither has zero parents now, so the forest is empty — but it must
    // return, not stack-overflow.
    expect(featureTree(store)).toEqual([]);
  });

  it("expand: 'chain' nests blueprints and their work orders under each requirement", () => {
    const root = req("Root");
    const child = req("Child", root.id);
    const blueprint = store.createEntity({ type: "blueprint", title: "BP" });
    store.link(blueprint.id, child.id, "details");
    const wo = store.createEntity({ type: "work_order", title: "WO", status: "draft" });
    store.link(wo.id, blueprint.id, "implements");

    const tree = featureTree(store, { expand: "chain" });
    expect(tree).toHaveLength(1);
    // Every requirement node carries a blueprints array (empty when none).
    expect(tree[0].blueprints).toEqual([]);
    const childNode = tree[0].children[0];
    expect(childNode.blueprints?.map((b) => b.entity.id)).toEqual([blueprint.id]);
    expect(childNode.blueprints?.[0].workOrders.map((w) => w.id)).toEqual([wo.id]);
  });

  it("plain calls omit the blueprints field entirely", () => {
    req("Root");
    expect(featureTree(store)[0].blueprints).toBeUndefined();
  });
});
