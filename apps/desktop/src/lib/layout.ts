import type { EntityType, GraphSnapshot } from "@kiln/core";

// Pure, deterministic layout for the Project X-ray (Phase 7). Position is
// semantic, not physical: horizontal = pipeline stage, vertical = feature lane
// (WO④). React Flow only renders these positions — the "brain" lives here and
// is unit-tested.

export interface XY {
  x: number;
  y: number;
}

// A horizontal feature band: every node whose nearest root requirement is this
// lane, laid out across the four pipeline columns.
export interface Lane {
  id: string;
  label: string;
  y: number;
  height: number;
}

export interface XRayLayout {
  positions: Record<string, XY>;
  lanes: Lane[];
  laneOf: Record<string, string>;
}

// Pipeline stage → column index (the intent → execution axis).
const STAGE: Record<EntityType, number> = { artifact: 0, requirement: 1, blueprint: 2, work_order: 3 };

export const COLUMN_WIDTH = 300;
export const ROW_HEIGHT = 84;
export const LANE_GAP = 40;
export const LANE_LABEL_H = 40; // vertical room reserved for a lane's label
export const UNFILED_LANE = "__unfiled__";

// laneOf: node id -> lane id (a root requirement id, or UNFILED_LANE for nodes
// with no requirement to inherit from). order: lane ids top-to-bottom.
// label: lane id -> display title.
export function assignLanes(snapshot: GraphSnapshot): {
  laneOf: Record<string, string>;
  order: string[];
  label: Record<string, string>;
} {
  const titleOf: Record<string, string> = {};
  for (const n of snapshot.nodes) titleOf[n.id] = n.title;

  // Edge maps from the snapshot's typed edges.
  const parentOf: Record<string, string> = {}; // child_of: child -> parent
  const bpReq: Record<string, string> = {}; // details: blueprint -> requirement
  const woBp: Record<string, string> = {}; // implements: work_order -> blueprint
  const artReqs: Record<string, string[]> = {}; // references: artifact -> requirements (reverse)
  for (const e of snapshot.edges) {
    if (e.type === "child_of") parentOf[e.fromId] = e.toId;
    else if (e.type === "details") bpReq[e.fromId] = e.toId;
    else if (e.type === "implements") woBp[e.fromId] = e.toId;
    else if (e.type === "references") (artReqs[e.toId] ??= []).push(e.fromId);
  }

  // Product-root convention (Phase 14) — duplicated from core's roots.ts on
  // the snapshot, because the webview does not import runtime core (the
  // Phase 13 stable-stringify precedent): exactly one parentless requirement,
  // and it has requirement children. Null for flat snapshots — every code
  // path below is then identical to before.
  const reqNodes = snapshot.nodes.filter((n) => n.type === "requirement");
  const rootReqs = reqNodes.filter((n) => parentOf[n.id] === undefined);
  const productRoot =
    rootReqs.length === 1 && reqNodes.some((n) => parentOf[n.id] === rootReqs[0].id) ? rootReqs[0].id : null;

  // The lane root of a requirement: walk child_of up until there is no parent
  // — or, when a product root exists, until the NEXT step up would be the
  // product root, so its children become the lane roots and the product root
  // keeps a dedicated lane of its own. Cycle-guarded so a pathological
  // child_of loop terminates.
  const rootOf = (reqId: string): string => {
    const seen = new Set<string>();
    let cur = reqId;
    while (parentOf[cur] !== undefined && parentOf[cur] !== productRoot && !seen.has(cur)) {
      seen.add(cur);
      cur = parentOf[cur];
    }
    return cur;
  };

  const laneOf: Record<string, string> = {};
  for (const n of snapshot.nodes) {
    let req: string | undefined;
    if (n.type === "requirement") req = n.id;
    else if (n.type === "blueprint") req = bpReq[n.id];
    else if (n.type === "work_order") req = bpReq[woBp[n.id]];
    else if (n.type === "artifact") req = artReqs[n.id]?.[0]; // first referencing requirement (edges are sorted)
    laneOf[n.id] = req ? rootOf(req) : UNFILED_LANE;
  }

  // Lanes ordered by the lane root's title; the product lane (when one
  // exists) first, unfiled last.
  const roots = [...new Set(Object.values(laneOf))].filter((id) => id !== UNFILED_LANE && id !== productRoot);
  roots.sort((a, b) => (titleOf[a] ?? "").localeCompare(titleOf[b] ?? "") || a.localeCompare(b));
  const order = productRoot !== null ? [productRoot, ...roots] : roots.slice();
  if (Object.values(laneOf).includes(UNFILED_LANE)) order.push(UNFILED_LANE);

  const label: Record<string, string> = { [UNFILED_LANE]: "Unfiled" };
  for (const id of order) if (id !== UNFILED_LANE) label[id] = titleOf[id] ?? id;

  return { laneOf, order, label };
}

// The tight bounding rectangle around a set of placed rectangles (Phase 13 —
// the Frame-context action fits the viewport to the traced nodes' bounds).
// Returns null for an empty set so callers can no-op instead of framing origin.
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function boundingRect(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((r) => r.x));
  const top = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const bottom = Math.max(...rects.map((r) => r.y + r.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

// Assigns each node an { x, y }: x by pipeline stage, y within its feature lane
// (stacked per column). Returns the lane bands for the background layer.
// graphSnapshot orders nodes by (stage, title, id), so stacking is stable.
export function layoutXRay(snapshot: GraphSnapshot): XRayLayout {
  const { laneOf, order, label } = assignLanes(snapshot);
  const positions: Record<string, XY> = {};
  const lanes: Lane[] = [];

  let laneY = 0;
  for (const laneId of order) {
    const laneNodes = snapshot.nodes.filter((n) => laneOf[n.id] === laneId);
    const rowInColumn: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
    let maxRows = 0;
    const contentTop = laneY + LANE_LABEL_H;
    for (const n of laneNodes) {
      const col = STAGE[n.type];
      const row = rowInColumn[col]++;
      positions[n.id] = { x: col * COLUMN_WIDTH, y: contentTop + row * ROW_HEIGHT };
      maxRows = Math.max(maxRows, rowInColumn[col]);
    }
    const height = LANE_LABEL_H + Math.max(maxRows, 1) * ROW_HEIGHT;
    lanes.push({ id: laneId, label: label[laneId], y: laneY, height });
    laneY += height + LANE_GAP;
  }

  return { positions, lanes, laneOf };
}
