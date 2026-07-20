import type { Entity, Id, WorkOrderStatus } from "../domain";
import { NotFoundError } from "../errors";
import type { Store } from "../store";

// A depends_on target of a work order, with its current status — enough for an
// agent to explain why a work order is sequenced the way it is.
export interface DependencyInfo {
  id: Id;
  title: string;
  status: WorkOrderStatus | null;
}

// Every depends_on target of a work order (done or not), for reporting. Order
// follows the stored edges.
export function workOrderDependencies(store: Store, id: Id): DependencyInfo[] {
  if (!store.getEntity(id)) throw new NotFoundError(id);
  return store
    .linked(id, "depends_on")
    .map((dep) => ({ id: dep.id, title: dep.title, status: dep.status }));
}

// The depends_on targets that are NOT yet `done`, and therefore block this work
// order (FRD-3 dependency-aware readiness). Direct targets only: sequencing
// falls out transitively because a blocked target is itself withheld from the
// ready list until ITS dependencies finish. That makes this inherently
// cycle-proof — a dependency cycle just leaves every member blocked (each has an
// unfinished neighbour), with no graph traversal to loop on.
export function blockingDependencies(store: Store, id: Id): Entity[] {
  if (!store.getEntity(id)) throw new NotFoundError(id);
  return store.linked(id, "depends_on").filter((dep) => dep.status !== "done");
}

// Work orders an agent may pick up right now: status `ready` AND no blocking
// dependencies. This is the honest answer list_ready_work_orders must return —
// a `ready` work order whose groundwork is unfinished is withheld, not offered.
export function readyWorkOrders(store: Store): Entity[] {
  return store
    .workOrdersByStatus("ready")
    .filter((wo) => blockingDependencies(store, wo.id).length === 0);
}
