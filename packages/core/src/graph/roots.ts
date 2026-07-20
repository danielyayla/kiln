import type { Entity } from "../domain";
import type { Store } from "../store";

// The product root (Phase 14 — BP-14 §1) is a CONVENTION, not a schema marker:
// a store has one exactly when it contains a single parentless requirement and
// that requirement either has requirement children or carries a `details`
// blueprint (the design doc every seeded project is born with — Projects BP),
// so a freshly created, childless project is never misrendered as a bare
// feature list. Any other shape — including a flat store of sibling roots —
// has no product root and behaves as before.
// Accepted cosmetic edge: a store whose only feature has sub-requirements
// reads as a product root; this self-heals as soon as a second root appears.

export function rootRequirements(store: Store): Entity[] {
  return store.listEntities("requirement").filter((r) => store.linked(r.id, "child_of").length === 0);
}

const requirementChildren = (store: Store, id: Entity["id"]) =>
  store.linkedFrom(id, "child_of").filter((e) => e.type === "requirement");

export function productRoot(store: Store): Entity | null {
  const roots = rootRequirements(store);
  if (roots.length !== 1) return null;
  if (requirementChildren(store, roots[0].id).length > 0) return roots[0];
  const detailedBy = store
    .linkedFrom(roots[0].id, "details")
    .some((e) => e.type === "blueprint");
  return detailedBy ? roots[0] : null;
}

// The feature set every per-feature view (Pulse rows, X-ray lanes) is built
// from: the product root's requirement children when the convention holds,
// else the parentless requirements themselves. Callers sort.
export function featureRoots(store: Store): Entity[] {
  const root = productRoot(store);
  return root ? requirementChildren(store, root.id) : rootRequirements(store);
}
