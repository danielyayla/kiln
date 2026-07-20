import type { GraphSnapshot, LinkType } from "@kiln/core";

// The signature X-ray interaction (Phase 7): the full intent↔execution thread
// through one node. Pure over the snapshot the webview already holds.
//
// The four "pipeline" edge types all point from the execution side to the
// intent side (work_order --implements--> blueprint --details--> requirement
// --references--> artifact; child --child_of--> parent). So from any node:
//   backward (toward intent)   = follow those edges  (from → to)
//   forward  (toward execution)= follow them reversed (to → from)
// depends_on is peer sequencing, not the intent thread, so it is not traversed
// (a depends_on edge between two members still renders as part of the thread).

const LINEAGE_TYPES: ReadonlySet<LinkType> = new Set(["references", "details", "implements", "child_of"]);

export interface Lineage {
  nodes: Set<string>;
  edges: Set<string>; // edge ids "from-to-type", matching XRayView's edge ids
}

export function traceLineage(snapshot: GraphSnapshot, id: string): Lineage {
  const backward = new Map<string, string[]>(); // toward intent
  const forward = new Map<string, string[]>(); // toward execution
  const push = (m: Map<string, string[]>, k: string, v: string) => m.set(k, [...(m.get(k) ?? []), v]);
  for (const e of snapshot.edges) {
    if (!LINEAGE_TYPES.has(e.type)) continue;
    push(backward, e.fromId, e.toId);
    push(forward, e.toId, e.fromId);
  }

  const reach = (start: string, adj: Map<string, string[]>): Set<string> => {
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const nxt of adj.get(cur) ?? []) {
        if (!seen.has(nxt)) {
          seen.add(nxt);
          queue.push(nxt);
        }
      }
    }
    return seen;
  };

  const nodes = new Set<string>([id, ...reach(id, backward), ...reach(id, forward)]);

  // Phase 16: ancestor requirements contribute their details blueprint — the
  // same first-by-(title, id) pick as core's LineageEntry.blueprint — so the
  // lit thread equals the assembled context (receipts and the glance card
  // already carry it). Ancestors only: the parent side of an in-thread
  // child_of edge. The start node's own requirement keeps today's behavior
  // (its sibling blueprints stay unlit), and the added blueprint is a leaf —
  // nothing expands from it.
  const title = new Map(snapshot.nodes.map((n) => [n.id, n.title] as const));
  const isBlueprint = new Set(snapshot.nodes.filter((n) => n.type === "blueprint").map((n) => n.id));
  const ancestors = new Set(
    snapshot.edges
      .filter((e) => e.type === "child_of" && nodes.has(e.fromId) && nodes.has(e.toId))
      .map((e) => e.toId),
  );
  for (const req of ancestors) {
    const detailing = snapshot.edges
      .filter((e) => e.type === "details" && e.toId === req && isBlueprint.has(e.fromId))
      .map((e) => e.fromId)
      .sort((a, b) => (title.get(a) ?? "").localeCompare(title.get(b) ?? "") || a.localeCompare(b));
    if (detailing[0]) nodes.add(detailing[0]);
  }

  const edges = new Set<string>();
  for (const e of snapshot.edges) {
    if (nodes.has(e.fromId) && nodes.has(e.toId)) edges.add(`${e.fromId}-${e.toId}-${e.type}`);
  }
  return { nodes, edges };
}
