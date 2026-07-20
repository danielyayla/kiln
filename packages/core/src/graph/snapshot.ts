import { ENTITY_TYPES, type Entity, type EntityType, type Id, type LinkType, type WorkOrderStatus } from "../domain";
import type { Store } from "../store";

// A whole-graph snapshot for visualization (Phase 7 — Project X-ray). Pure over
// the Store: the desktop sidecar serves this from one `GET /graph` call so the
// webview never issues N per-entity requests.

export interface GraphNode {
  id: Id;
  type: EntityType;
  title: string;
  // A work order's own lifecycle status; null for the other types.
  status: WorkOrderStatus | null;
  // Rolled-up completion for requirements/blueprints: the fraction of their
  // (non-cancelled) descendant work orders that are `done`, in [0, 1]. `null`
  // when there is nothing to complete (artifacts and work orders always; a
  // requirement/blueprint with no non-cancelled descendant work orders).
  progress: number | null;
}

export interface GraphEdge {
  fromId: Id;
  toId: Id;
  type: LinkType;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// Stage order along the pipeline — also the deterministic node sort key.
const STAGE: Record<EntityType, number> = { artifact: 0, requirement: 1, blueprint: 2, work_order: 3 };

// The work orders "under" a requirement (its whole child_of subtree's blueprints)
// or a blueprint (the work orders implementing it). Deduped by id.
// Exported for reuse by pulse.ts (Phase 10) — same rollup semantics everywhere.
export function descendantWorkOrders(store: Store, entity: Entity): Entity[] {
  const seen = new Map<Id, Entity>();
  const collectFromBlueprint = (blueprintId: Id) => {
    for (const wo of store.linkedFrom(blueprintId, "implements")) {
      if (wo.type === "work_order") seen.set(wo.id, wo);
    }
  };
  if (entity.type === "blueprint") {
    collectFromBlueprint(entity.id);
  } else if (entity.type === "requirement") {
    for (const req of store.subtree(entity.id)) {
      if (req.type !== "requirement") continue;
      for (const bp of store.linkedFrom(req.id, "details")) {
        if (bp.type === "blueprint") collectFromBlueprint(bp.id);
      }
    }
  }
  return [...seen.values()];
}

// done / non-cancelled, or null when there is no non-cancelled work to measure.
// Cancelled work is out of scope, so it counts toward neither side.
// Exported for reuse by pulse.ts (Phase 10).
export function rollup(workOrders: Entity[]): number | null {
  const countable = workOrders.filter((w) => w.status !== "cancelled");
  if (countable.length === 0) return null;
  const done = countable.filter((w) => w.status === "done").length;
  return done / countable.length;
}

function nodeProgress(store: Store, entity: Entity): number | null {
  if (entity.type === "requirement" || entity.type === "blueprint") {
    return rollup(descendantWorkOrders(store, entity));
  }
  return null; // artifacts have nothing to complete; work orders convey state via `status`
}

// Assemble the whole graph, deterministically ordered so reruns are stable and
// diffable: nodes by (pipeline stage, title, id); edges already come from
// listLinks() ordered by (type, fromId, toId).
export function graphSnapshot(store: Store): GraphSnapshot {
  const entities = ENTITY_TYPES.flatMap((t) => store.listEntities(t));

  const nodes: GraphNode[] = entities
    .map((e) => ({
      id: e.id,
      type: e.type,
      title: e.title,
      status: e.status,
      progress: nodeProgress(store, e),
    }))
    .sort((a, b) => STAGE[a.type] - STAGE[b.type] || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));

  const edges: GraphEdge[] = store.listLinks();

  return { nodes, edges };
}
