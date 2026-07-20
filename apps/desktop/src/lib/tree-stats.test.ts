import { describe, expect, it } from "vitest";
import type { Entity, FeatureTreeNode } from "@kiln/core";
import { productRootNode, treeProgress } from "./tree-stats";

const ent = (over: Partial<Entity>): Entity => ({
  id: "id",
  type: "requirement",
  title: "T",
  body: "",
  status: null,
  assignee: null,
  createdAt: "t",
  updatedAt: "t",
  ...over,
});

const wo = (id: string, status: Entity["status"]) => ent({ id, type: "work_order", status });

const node = (id: string, over: Partial<FeatureTreeNode> = {}): FeatureTreeNode => ({
  entity: ent({ id }),
  children: [],
  ...over,
});

describe("treeProgress", () => {
  it("counts done over non-cancelled across blueprints and nested children", () => {
    const tree = node("root", {
      blueprints: [
        { entity: ent({ id: "bp1", type: "blueprint" }), workOrders: [wo("w1", "done"), wo("w2", "cancelled")] },
      ],
      children: [
        node("child", {
          blueprints: [
            { entity: ent({ id: "bp2", type: "blueprint" }), workOrders: [wo("w3", "ready"), wo("w4", "done")] },
          ],
        }),
      ],
    });
    // w2 cancelled -> out of the denominator; w1 + w4 done of w1, w3, w4.
    expect(treeProgress(tree)).toEqual({ done: 2, total: 3 });
  });

  it("treats a null status as draft (countable, not done) and handles empty nodes", () => {
    const tree = node("root", {
      blueprints: [{ entity: ent({ id: "bp", type: "blueprint" }), workOrders: [wo("w", null)] }],
    });
    expect(treeProgress(tree)).toEqual({ done: 0, total: 1 });
    expect(treeProgress(node("bare"))).toEqual({ done: 0, total: 0 });
  });
});

describe("productRootNode", () => {
  it("detects the single-root-with-children convention", () => {
    const product = node("kiln", { children: [node("feature")] });
    expect(productRootNode([product])?.entity.id).toBe("kiln");
  });

  it("detects a childless root carrying a details blueprint (fresh seeded project)", () => {
    const product = node("new", {
      blueprints: [{ entity: ent({ id: "doc", type: "blueprint" }), workOrders: [] }],
    });
    expect(productRootNode([product])?.entity.id).toBe("new");
  });

  it("returns null for flat stores, multiple roots, and a bare childless lone root", () => {
    expect(productRootNode([])).toBeNull();
    expect(productRootNode([node("a"), node("b")])).toBeNull();
    expect(productRootNode([node("lone")])).toBeNull();
    expect(productRootNode([node("lone", { blueprints: [] })])).toBeNull();
  });
});
