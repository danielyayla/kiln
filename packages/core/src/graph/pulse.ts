import {
  ENTITY_TYPES,
  WORK_ORDER_STATUSES,
  type Entity,
  type EntityType,
  type Id,
  type WorkOrderStatus,
} from "../domain";
import type { Store } from "../store";
import { DEFAULT_STATUS } from "../transitions";
import { assembleWorkOrderContext } from "./context";
import { contextHealth, type HealthCheck } from "./health";
import { criticalPath, graphGaps, type GraphGaps } from "./overlays";
import { blockingDependencies, readyWorkOrders } from "./readiness";
import { featureRoots } from "./roots";
import { descendantWorkOrders, rollup } from "./snapshot";

// Project Pulse (Phase 10 — BP-10 §1a): the whole project's health as one pure,
// deterministic read over the Store. Everything here is derived — rendering the
// dashboard never calls a model and never writes.

// A work-order reference with its lifecycle status, for lists the dashboard renders.
export interface WorkOrderRef {
  id: Id;
  title: string;
  status: WorkOrderStatus | null;
}

export interface FeatureHealth {
  id: Id;
  title: string;
  // done / non-cancelled descendant work orders — same rollup as graphSnapshot.
  progress: number | null;
  // Counts over the feature's descendant work orders.
  workOrders: Record<WorkOrderStatus, number>;
  // Descendant work orders that are ready but withheld by unfinished depends_on.
  blocked: number;
  // Structural dead-ends in the subtree: requirements with no `details`
  // blueprint + blueprints with no `implements` work order.
  gaps: number;
}

export interface BlockedWorkOrder {
  id: Id;
  title: string;
  blocking: WorkOrderRef[];
}

export interface ProjectPulse {
  counts: Record<EntityType, number>;
  workOrders: { total: number; byStatus: Record<WorkOrderStatus, number> };
  // done / non-cancelled across ALL work orders; null when there is none.
  completion: number | null;
  // One per feature root — the product root's requirement children when the
  // single-root convention holds (Phase 14), else the root requirements
  // themselves — sorted (title, id). The product root is never a feature row.
  features: FeatureHealth[];
  // The longest chain of unfinished work orders, hydrated for display.
  criticalPath: WorkOrderRef[];
  // Ready-but-blocked work orders with what blocks them, sorted (title, id).
  blocked: BlockedWorkOrder[];
  // What is happening right now (Phase 11 — Pulse as home): work in flight,
  // and the honest agent list — exactly what list_ready_work_orders offers.
  now: { inProgress: WorkOrderRef[]; next: WorkOrderRef[] };
}

const byTitleThenId = (a: { title: string; id: Id }, b: { title: string; id: Id }) =>
  a.title.localeCompare(b.title) || a.id.localeCompare(b.id);

const emptyStatusCounts = (): Record<WorkOrderStatus, number> =>
  Object.fromEntries(WORK_ORDER_STATUSES.map((s) => [s, 0])) as Record<WorkOrderStatus, number>;

const toRef = (e: Entity): WorkOrderRef => ({ id: e.id, title: e.title, status: e.status });

// A work order created without an explicit status has status null in the
// store; everywhere in the product (board, transitions) that means "draft".
const effectiveStatus = (wo: Entity): WorkOrderStatus => wo.status ?? DEFAULT_STATUS;

const isReadyButBlocked = (store: Store, wo: Entity) =>
  wo.status === "ready" && blockingDependencies(store, wo.id).length > 0;

// Subtree gaps: graphGaps memberships scoped to one feature's subtree. Pulse
// COUNTS the shared overlay result rather than re-deriving the rules, so it
// can never disagree with the X-ray badge or /graph/gaps (it did twice: the
// Phase 16 root exemption and the 2026-07-11 descendant-coverage exemption).
function subtreeGaps(store: Store, root: Entity, gaps: GraphGaps): number {
  const gapReqs = new Set(gaps.requirements);
  const gapBps = new Set(gaps.blueprints);
  let count = 0;
  for (const req of store.subtree(root.id)) {
    if (req.type !== "requirement") continue;
    if (gapReqs.has(req.id)) count += 1;
    for (const bp of store.linkedFrom(req.id, "details")) {
      if (gapBps.has(bp.id)) count += 1;
    }
  }
  return count;
}

function featureHealth(store: Store, root: Entity, gaps: GraphGaps): FeatureHealth {
  const workOrders = descendantWorkOrders(store, root);
  const byStatus = emptyStatusCounts();
  for (const wo of workOrders) byStatus[effectiveStatus(wo)] += 1;
  return {
    id: root.id,
    title: root.title,
    progress: rollup(workOrders),
    workOrders: byStatus,
    blocked: workOrders.filter((wo) => isReadyButBlocked(store, wo)).length,
    gaps: subtreeGaps(store, root, gaps),
  };
}

// Knowledge health (BP-10 §1b): the Phase 8 structural context checks run over
// every ACTIVE work order and rolled up worst-first — which agent handoffs
// would be weak, before an agent is handed them. Purely structural: no model
// call, no writes (viewing is not a handoff; no receipts recorded).

export interface WorkOrderHealth {
  id: Id;
  title: string;
  status: WorkOrderStatus;
  estTokens: number;
  errors: number;
  warns: number;
  infos: number;
  checks: HealthCheck[];
}

export interface KnowledgeHealth {
  // Worst-first: errors desc, then warns desc, then (title, id).
  workOrders: WorkOrderHealth[];
  // healthy = active work orders with zero errors and zero warns.
  totals: { errors: number; warns: number; healthy: number };
}

export function knowledgeHealth(store: Store): KnowledgeHealth {
  const active = store
    .listEntities("work_order")
    .filter((wo) => effectiveStatus(wo) !== "done" && effectiveStatus(wo) !== "cancelled");

  const workOrders = active
    .map((wo) => {
      const health = contextHealth(assembleWorkOrderContext(store, wo.id));
      const count = (level: HealthCheck["level"]) => health.checks.filter((c) => c.level === level).length;
      return {
        id: wo.id,
        title: wo.title,
        status: effectiveStatus(wo),
        estTokens: health.size.estTokens,
        errors: count("error"),
        warns: count("warn"),
        infos: count("info"),
        checks: health.checks,
      };
    })
    .sort((a, b) => b.errors - a.errors || b.warns - a.warns || byTitleThenId(a, b));

  return {
    workOrders,
    totals: {
      errors: workOrders.reduce((n, w) => n + w.errors, 0),
      warns: workOrders.reduce((n, w) => n + w.warns, 0),
      healthy: workOrders.filter((w) => w.errors === 0 && w.warns === 0).length,
    },
  };
}

// Activity timeline (BP-10 §1c): recent project events merged from records
// Kiln already keeps — no new tables, no Store change. Entity creation,
// committed revisions, context receipts (real agent handoffs), and completion
// receipts (what the agent handed back).

export interface ActivityEvent {
  at: string;
  kind: "created" | "revised" | "handoff" | "completed";
  entityId: Id;
  entityType: EntityType;
  title: string;
}

export function activityTimeline(store: Store, limit = 50): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const type of ENTITY_TYPES) {
    for (const e of store.listEntities(type)) {
      events.push({ at: e.createdAt, kind: "created", entityId: e.id, entityType: e.type, title: e.title });
      for (const r of store.listRevisions(e.id))
        events.push({ at: r.createdAt, kind: "revised", entityId: e.id, entityType: e.type, title: e.title });
      if (e.type === "work_order") {
        for (const receipt of store.listContextReceipts(e.id))
          events.push({ at: receipt.createdAt, kind: "handoff", entityId: e.id, entityType: e.type, title: e.title });
        for (const receipt of store.listCompletionReceipts(e.id))
          events.push({ at: receipt.createdAt, kind: "completed", entityId: e.id, entityType: e.type, title: e.title });
      }
    }
  }
  // Newest first; same-instant events break ties by (kind, entityId) so reruns
  // are stable. ISO-8601 strings compare correctly as strings.
  return events
    .sort((a, b) => b.at.localeCompare(a.at) || a.kind.localeCompare(b.kind) || a.entityId.localeCompare(b.entityId))
    .slice(0, Math.max(0, limit));
}

export function projectPulse(store: Store): ProjectPulse {
  const counts = Object.fromEntries(
    ENTITY_TYPES.map((t) => [t, store.listEntities(t).length]),
  ) as Record<EntityType, number>;

  const allWorkOrders = store.listEntities("work_order");
  const byStatus = emptyStatusCounts();
  for (const wo of allWorkOrders) byStatus[effectiveStatus(wo)] += 1;

  const roots = featureRoots(store).sort(byTitleThenId);

  const blocked = store
    .workOrdersByStatus("ready")
    .map((wo) => ({ wo, blocking: blockingDependencies(store, wo.id) }))
    .filter(({ blocking }) => blocking.length > 0)
    .map(({ wo, blocking }) => ({ id: wo.id, title: wo.title, blocking: blocking.map(toRef) }))
    .sort(byTitleThenId);

  const path = criticalPath(store)
    .map((id) => store.getEntity(id))
    .filter((e): e is Entity => e !== null)
    .map(toRef);

  const now = {
    inProgress: store.workOrdersByStatus("in_progress").map(toRef).sort(byTitleThenId),
    next: readyWorkOrders(store).map(toRef).sort(byTitleThenId),
  };

  const gaps = graphGaps(store);

  return {
    counts,
    workOrders: { total: allWorkOrders.length, byStatus },
    completion: rollup(allWorkOrders),
    features: roots.map((root) => featureHealth(store, root, gaps)),
    criticalPath: path,
    blocked,
    now,
  };
}
