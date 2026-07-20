import type { Entity } from "../domain";
import type { Store } from "../store";

// The product root (Phase 14 — BP-14 §1) is a CONVENTION, not a schema marker:
// a store has one exactly when it contains a single parentless requirement and
// that requirement has requirement children. Any other shape — including a
// flat store of sibling roots — has no product root and behaves as before.
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
  return requirementChildren(store, roots[0].id).length > 0 ? roots[0] : null;
}

// The feature set every per-feature view (Pulse rows, X-ray lanes) is built
// from: the product root's requirement children when the convention holds,
// else the parentless requirements themselves. Callers sort.
export function featureRoots(store: Store): Entity[] {
  const root = productRoot(store);
  return root ? requirementChildren(store, root.id) : rootRequirements(store);
}
