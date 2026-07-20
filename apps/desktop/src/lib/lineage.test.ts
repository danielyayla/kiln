import { describe, expect, it } from "vitest";
import type { GraphSnapshot } from "@kiln/core";
import { traceLineage } from "./lineage";

type NodeType = GraphSnapshot["nodes"][number]["type"];
const node = (id: string, type: NodeType) => ({ id, type, title: id, status: null, progress: null });
const edge = (fromId: string, toId: string, type: GraphSnapshot["edges"][number]["type"]) => ({ fromId, toId, type });

// art <-references- root <-child_of- child ; rootBp -details-> root ; wo -implements-> childBp -details-> child
// (a two-feature-ish chain so we can test both directions and isolation)
const SNAPSHOT: GraphSnapshot = {
  nodes: [
    node("art", "artifact"),
    node("root", "requirement"),
    node("child", "requirement"),
    node("rootBp", "blueprint"),
    node("childBp", "blueprint"),
    node("wo", "work_order"),
    node("other", "artifact"), // unconnected
  ],
  edges: [
    edge("root", "art", "references"),
    edge("child", "root", "child_of"),
    edge("rootBp", "root", "details"),
    edge("childBp", "child", "details"),
    edge("wo", "childBp", "implements"),
  ],
};

describe("traceLineage", () => {
  it("traces a work order BACKWARD to the root intent", () => {
    const { nodes } = traceLineage(SNAPSHOT, "wo");
    // wo -> childBp -> child -> root -> art
    expect(nodes.has("wo")).toBe(true);
    expect(nodes.has("childBp")).toBe(true);
    expect(nodes.has("child")).toBe(true);
    expect(nodes.has("root")).toBe(true);
    expect(nodes.has("art")).toBe(true); // reached the root artifact
    // Phase 16: the ancestor's details blueprint rides the thread — it is
    // part of the assembled context (LineageEntry.blueprint), so it lights.
    expect(nodes.has("rootBp")).toBe(true);
    expect(nodes.has("other")).toBe(false); // unconnected artifact stays out
  });

  it("traces an artifact FORWARD to everything it fed", () => {
    const { nodes } = traceLineage(SNAPSHOT, "art");
    // art <- root <- {rootBp, child} ; child <- childBp <- wo
    expect([...nodes].sort()).toEqual(["art", "child", "childBp", "root", "rootBp", "wo"].sort());
    expect(nodes.has("other")).toBe(false);
  });

  it("collects the edges whose endpoints are both in the lineage", () => {
    const { edges } = traceLineage(SNAPSHOT, "wo");
    expect(edges.has("wo-childBp-implements")).toBe(true);
    expect(edges.has("childBp-child-details")).toBe(true);
    expect(edges.has("child-root-child_of")).toBe(true);
    expect(edges.has("root-art-references")).toBe(true);
  });

  it("does not traverse depends_on (peer sequencing, not the intent thread)", () => {
    const snap: GraphSnapshot = {
      nodes: [node("a", "work_order"), node("b", "work_order")],
      edges: [edge("a", "b", "depends_on")],
    };
    const { nodes } = traceLineage(snap, "a");
    expect([...nodes]).toEqual(["a"]); // b is only a depends_on peer, not lineage
  });

  it("returns just the node itself when it is isolated", () => {
    expect([...traceLineage(SNAPSHOT, "other").nodes]).toEqual(["other"]);
  });
});

describe("traceLineage — ancestor blueprints (Phase 16)", () => {
  // product <- alpha <- (wo via alphaBp); product also has beta.
  // product carries TWO details blueprints ("a arch" wins by title);
  // alpha carries a sibling blueprint the wo does NOT implement.
  const titled = (id: string, type: NodeType, title: string) => ({ id, type, title, status: null, progress: null });
  const NESTED: GraphSnapshot = {
    nodes: [
      titled("product", "requirement", "Kiln"),
      titled("alpha", "requirement", "Alpha"),
      titled("beta", "requirement", "Beta"),
      titled("archB", "blueprint", "b arch"),
      titled("archA", "blueprint", "a arch"),
      titled("alphaBp", "blueprint", "Alpha BP"),
      titled("alphaBp2", "blueprint", "Alpha BP sibling"),
      titled("betaBp", "blueprint", "Beta BP"),
      titled("wo", "work_order", "WO"),
    ],
    edges: [
      edge("alpha", "product", "child_of"),
      edge("beta", "product", "child_of"),
      edge("archB", "product", "details"),
      edge("archA", "product", "details"),
      edge("alphaBp", "alpha", "details"),
      edge("alphaBp2", "alpha", "details"),
      edge("betaBp", "beta", "details"),
      edge("wo", "alphaBp", "implements"),
    ],
  };

  it("lights the ancestor's first-by-(title, id) blueprint and its details edge", () => {
    const { nodes, edges } = traceLineage(NESTED, "wo");
    expect(nodes.has("archA")).toBe(true);
    expect(nodes.has("archB")).toBe(false); // deterministic pick, one per ancestor
    expect(edges.has("archA-product-details")).toBe(true);
  });

  it("leaves the OWN requirement's sibling blueprints unlit", () => {
    const { nodes } = traceLineage(NESTED, "wo");
    expect(nodes.has("alphaBp")).toBe(true); // the implemented one, via the normal walk
    expect(nodes.has("alphaBp2")).toBe(false); // alpha is not an ancestor of itself
  });

  it("leaves sibling features unlit", () => {
    const { nodes } = traceLineage(NESTED, "wo");
    expect(nodes.has("beta")).toBe(false);
    expect(nodes.has("betaBp")).toBe(false);
  });

  it("changes nothing for a flat snapshot (no child_of in the thread)", () => {
    const FLAT: GraphSnapshot = {
      nodes: [titled("r", "requirement", "R"), titled("bp", "blueprint", "BP"), titled("w", "work_order", "W")],
      edges: [edge("bp", "r", "details"), edge("w", "bp", "implements")],
    };
    expect([...traceLineage(FLAT, "w").nodes].sort()).toEqual(["bp", "r", "w"]);
  });
});
