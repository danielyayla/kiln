import type { Entity, Id } from "../domain";
import { NotFoundError } from "../errors";
import type { Store } from "../store";

// One rung of inherited intent: an ancestor requirement and the artifacts it
// references, folded into a work order's context so root-level intent reaches a
// nested work order (Phase 6).
export interface LineageEntry {
  requirement: Entity;
  artifacts: Entity[];
  // The blueprint detailing this ancestor, when one exists (Phase 14): the
  // product root's architecture overview rides the same rail as inherited
  // artifacts. Absent — not null — when the ancestor has no details blueprint.
  blueprint?: Entity;
}

// The full linked context a coding agent receives for a single work order.
export interface WorkOrderContext {
  workOrder: Entity;
  blueprint: Entity | null;
  requirement: Entity | null;
  artifacts: Entity[];
  // Ancestor requirements up the child_of chain (nearest first), each with the
  // artifacts it references. An artifact referenced at multiple levels appears
  // once, at the nearest level (the work order's own `artifacts` are level 0).
  // Empty for a flat store — no child_of edges means no inherited intent.
  lineage: LineageEntry[];
}

// The heart of the product: walk the graph from a work order out to the intent
// behind it. Missing links yield typed partials rather than throwing, so an
// un-linked work order is a degraded-but-valid result, not an error. Beyond the
// work order's own requirement, we walk UP the requirement tree so a nested
// work order inherits root-level intent (Phase 6).
export function assembleWorkOrderContext(store: Store, id: Id): WorkOrderContext {
  const workOrder = store.getEntity(id);
  if (!workOrder) throw new NotFoundError(id);
  const blueprint = store.linked(id, "implements")[0] ?? null;
  const requirement = blueprint ? (store.linked(blueprint.id, "details")[0] ?? null) : null;
  const artifacts = requirement ? store.linked(requirement.id, "references") : [];

  // Nearest-wins dedup: the work order's own artifacts are level 0, so an
  // ancestor never repeats them, and an artifact shared by two ancestors is
  // kept only at the nearer one.
  const seen = new Set(artifacts.map((a) => a.id));
  const lineage: LineageEntry[] = [];
  if (requirement) {
    for (const ancestor of ancestors(store, requirement.id)) {
      const inherited = store.linked(ancestor.id, "references").filter((a) => !seen.has(a.id));
      for (const a of inherited) seen.add(a.id);
      // Several details blueprints are legal; take the first by (title, id)
      // so the assembled context (and its receipt hash) is deterministic.
      const detailing = store
        .linkedFrom(ancestor.id, "details")
        .filter((b) => b.type === "blueprint")
        .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
      lineage.push({ requirement: ancestor, artifacts: inherited, ...(detailing[0] && { blueprint: detailing[0] }) });
    }
  }

  return { workOrder, blueprint, requirement, artifacts, lineage };
}

// Feature-tree helpers over child_of edges.
export function ancestors(store: Store, requirementId: Id): Entity[] {
  const start = store.getEntity(requirementId);
  if (!start) throw new NotFoundError(requirementId);
  const out: Entity[] = [];
  const seen = new Set<string>([start.id]);
  let parents = store.linked(start.id, "child_of");
  while (parents.length > 0) {
    const parent = parents[0];
    if (seen.has(parent.id)) break;
    seen.add(parent.id);
    out.push(parent);
    parents = store.linked(parent.id, "child_of");
  }
  return out;
}

export function descendants(store: Store, requirementId: Id): Entity[] {
  return store.subtree(requirementId).filter((e) => e.id !== requirementId);
}
