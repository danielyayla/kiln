import { describe, expect, it } from "vitest";
import type { GraphSnapshot } from "@kiln/core";
import { COLUMN_WIDTH, ROW_HEIGHT, UNFILED_LANE, assignLanes, boundingRect, layoutXRay } from "./layout";

type NodeType = GraphSnapshot["nodes"][number]["type"];
const node = (id: string, type: NodeType, title = id) => ({ id, type, title, status: null, progress: null });
const edge = (fromId: string, toId: string, type: GraphSnapshot["edges"][number]["type"]) => ({ fromId, toId, type });

describe("assignLanes", () => {
  it("assigns each node to its nearest root requirement", () => {
    // root <- child(child_of); rootBp details root; leafWo implements childBp details child;
    // art referenced by root.
    const snapshot: GraphSnapshot = {
      nodes: [
        node("root", "requirement", "Root"),
        node("child", "requirement", "Child"),
        node("rootBp", "blueprint"),
        node("childBp", "blueprint"),
        node("wo", "work_order"),
        node("art", "artifact"),
        // A sibling root keeps this snapshot flat — a LONE root with a
        // requirement child would be a product root (Phase 14) instead.
        node("sibling", "requirement", "Sibling"),
      ],
      edges: [
        edge("child", "root", "child_of"),
        edge("rootBp", "root", "details"),
        edge("childBp", "child", "details"),
        edge("wo", "childBp", "implements"),
        edge("root", "art", "references"),
      ],
    };
    const { laneOf } = assignLanes(snapshot);
    // Everything traces up to the single root.
    expect(laneOf.root).toBe("root");
    expect(laneOf.child).toBe("root"); // nested requirement inherits its root
    expect(laneOf.rootBp).toBe("root");
    expect(laneOf.childBp).toBe("root"); // via child -> root
    expect(laneOf.wo).toBe("root"); // via childBp -> child -> root
    expect(laneOf.art).toBe("root"); // via referencing requirement
  });

  it("separates independent features into their own lanes and orders them by title", () => {
    const snapshot: GraphSnapshot = {
      nodes: [node("b", "requirement", "Beta feature"), node("a", "requirement", "Alpha feature")],
      edges: [],
    };
    const { order, label } = assignLanes(snapshot);
    expect(order).toEqual(["a", "b"]); // ordered by title: Alpha, Beta
    expect(label.a).toBe("Alpha feature");
  });

  it("product root (Phase 14): children become lane roots; the root gets a dedicated first lane", () => {
    // product <- alpha, beta (features); deep <- alpha; productBp details product;
    // deepWo implements deepBp details deep; productArt referenced by product.
    const snapshot: GraphSnapshot = {
      nodes: [
        node("product", "requirement", "Kiln"),
        node("beta", "requirement", "Beta feature"),
        node("alpha", "requirement", "Alpha feature"),
        node("deep", "requirement", "Nested under alpha"),
        node("productBp", "blueprint", "Architecture"),
        node("deepBp", "blueprint"),
        node("deepWo", "work_order"),
        node("productArt", "artifact", "Product brief"),
        node("loose", "artifact"),
      ],
      edges: [
        edge("beta", "product", "child_of"),
        edge("alpha", "product", "child_of"),
        edge("deep", "alpha", "child_of"),
        edge("productBp", "product", "details"),
        edge("deepBp", "deep", "details"),
        edge("deepWo", "deepBp", "implements"),
        edge("product", "productArt", "references"),
      ],
    };
    const { laneOf, order, label } = assignLanes(snapshot);
    // The product root and its own blueprint/artifact share the dedicated lane.
    expect(laneOf.product).toBe("product");
    expect(laneOf.productBp).toBe("product");
    expect(laneOf.productArt).toBe("product");
    // Features are the lane roots; deep nodes stop at their depth-1 ancestor.
    expect(laneOf.alpha).toBe("alpha");
    expect(laneOf.beta).toBe("beta");
    expect(laneOf.deep).toBe("alpha");
    expect(laneOf.deepBp).toBe("alpha");
    expect(laneOf.deepWo).toBe("alpha");
    // Product lane first, then features by title, unfiled last — all labeled.
    expect(order).toEqual(["product", "alpha", "beta", UNFILED_LANE]);
    expect(label.product).toBe("Kiln");
    expect(label.alpha).toBe("Alpha feature");
    expect(laneOf.loose).toBe(UNFILED_LANE);
  });

  it("a childless root with a details blueprint gets the product lane (fresh seeded project)", () => {
    const snapshot: GraphSnapshot = {
      nodes: [node("root", "requirement", "New project"), node("doc", "blueprint", "Architecture")],
      edges: [edge("doc", "root", "details")],
    };
    const { laneOf, order, label } = assignLanes(snapshot);
    expect(laneOf.root).toBe("root");
    expect(laneOf.doc).toBe("root");
    expect(order).toEqual(["root"]);
    expect(label.root).toBe("New project");
  });

  it("a childless root with no details blueprint keeps flat behavior", () => {
    const snapshot: GraphSnapshot = {
      nodes: [node("solo", "requirement", "Solo")],
      edges: [],
    };
    const { order } = assignLanes(snapshot);
    expect(order).toEqual(["solo"]);
  });

  it("two parentless requirements mean no product root — flat behavior unchanged", () => {
    const snapshot: GraphSnapshot = {
      nodes: [
        node("a", "requirement", "Alpha"),
        node("b", "requirement", "Beta"),
        node("childOfA", "requirement", "Nested"),
      ],
      edges: [edge("childOfA", "a", "child_of")],
    };
    const { laneOf, order } = assignLanes(snapshot);
    expect(laneOf.childOfA).toBe("a"); // walks to the true root, not its parent
    expect(order).toEqual(["a", "b"]);
  });

  it("puts nodes with no requirement to inherit from in the Unfiled lane, last", () => {
    const snapshot: GraphSnapshot = {
      nodes: [node("r", "requirement", "Feature"), node("looseBp", "blueprint"), node("looseArt", "artifact")],
      edges: [],
    };
    const { laneOf, order, label } = assignLanes(snapshot);
    expect(laneOf.looseBp).toBe(UNFILED_LANE);
    expect(laneOf.looseArt).toBe(UNFILED_LANE);
    expect(order).toEqual(["r", UNFILED_LANE]); // unfiled always last
    expect(label[UNFILED_LANE]).toBe("Unfiled");
  });
});

describe("boundingRect", () => {
  it("returns the tight bounds around placed rectangles", () => {
    expect(
      boundingRect([
        { x: 0, y: 100, width: 240, height: 30 },
        { x: 600, y: 40, width: 240, height: 30 },
        { x: 300, y: 250, width: 240, height: 30 },
      ]),
    ).toEqual({ x: 0, y: 40, width: 840, height: 240 });
  });

  it("returns a single rectangle unchanged", () => {
    expect(boundingRect([{ x: 5, y: 6, width: 7, height: 8 }])).toEqual({ x: 5, y: 6, width: 7, height: 8 });
  });

  it("returns null for an empty set so callers can no-op", () => {
    expect(boundingRect([])).toBeNull();
  });
});

describe("layoutXRay", () => {
  it("places each entity type in its own column by pipeline stage", () => {
    const snapshot: GraphSnapshot = {
      nodes: [node("a", "artifact"), node("r", "requirement"), node("b", "blueprint"), node("w", "work_order")],
      edges: [edge("b", "r", "details"), edge("w", "b", "implements"), edge("r", "a", "references")],
    };
    const { positions } = layoutXRay(snapshot);
    expect(positions.a.x).toBe(0);
    expect(positions.r.x).toBe(COLUMN_WIDTH);
    expect(positions.b.x).toBe(2 * COLUMN_WIDTH);
    expect(positions.w.x).toBe(3 * COLUMN_WIDTH);
  });

  it("stacks same-column nodes within a lane by ROW_HEIGHT", () => {
    // Two work orders in the same feature (both implement blueprints under root).
    const snapshot: GraphSnapshot = {
      nodes: [
        node("r", "requirement", "R"),
        node("bp", "blueprint"),
        node("w1", "work_order", "w1"),
        node("w2", "work_order", "w2"),
      ],
      edges: [edge("bp", "r", "details"), edge("w1", "bp", "implements"), edge("w2", "bp", "implements")],
    };
    const { positions } = layoutXRay(snapshot);
    expect(positions.w2.y - positions.w1.y).toBe(ROW_HEIGHT);
    expect(positions.w1.x).toBe(3 * COLUMN_WIDTH);
    expect(positions.w2.x).toBe(3 * COLUMN_WIDTH);
  });

  it("bands lanes vertically with no overlap", () => {
    const snapshot: GraphSnapshot = {
      nodes: [node("a", "requirement", "Alpha"), node("b", "requirement", "Beta")],
      edges: [],
    };
    const { positions, lanes } = layoutXRay(snapshot);
    expect(lanes.map((l) => l.label)).toEqual(["Alpha", "Beta"]);
    // Beta's node sits below Alpha's whole band.
    expect(positions.b.y).toBeGreaterThan(lanes[0].y + lanes[0].height);
    // Bands do not overlap: lane[1] starts at or after lane[0]'s bottom.
    expect(lanes[1].y).toBeGreaterThanOrEqual(lanes[0].y + lanes[0].height);
  });

  it("is deterministic", () => {
    const snapshot: GraphSnapshot = {
      nodes: [node("r", "requirement"), node("a", "artifact"), node("w", "work_order")],
      edges: [edge("r", "a", "references")],
    };
    expect(layoutXRay(snapshot)).toEqual(layoutXRay(snapshot));
  });

  it("handles an empty snapshot", () => {
    expect(layoutXRay({ nodes: [], edges: [] })).toEqual({ positions: {}, lanes: [], laneOf: {} });
  });
});
