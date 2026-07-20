import type { Entity } from "../domain";
import type { Store } from "../store";

// A blueprint hanging off a requirement node, with the work orders that
// implement it (BP-6 unified navigator).
export interface BlueprintNode {
  entity: Entity;
  workOrders: Entity[];
}

// The nested feature tree (BP-5): requirements arranged by child_of edges.
// With { expand: "chain" } each node also carries its details-linked
// blueprints and their implements-linked work orders (BP-6).
export interface FeatureTreeNode {
  entity: Entity;
  children: FeatureTreeNode[];
  blueprints?: BlueprintNode[];
}

export interface FeatureTreeOptions {
  expand?: "chain";
}

// Roots are requirements with no parent; children follow child_of edges.
// A seen-set guards against pathological cycles in the links table — a cyclic
// node is rendered where first encountered and not repeated.
export function featureTree(store: Store, options: FeatureTreeOptions = {}): FeatureTreeNode[] {
  const requirements = store.listEntities("requirement");
  const roots = requirements.filter((r) => store.linked(r.id, "child_of").length === 0);
  const seen = new Set<string>();

  const build = (entity: Entity): FeatureTreeNode => {
    seen.add(entity.id);
    const children = store
      .children(entity.id)
      .filter((c) => c.type === "requirement" && !seen.has(c.id))
      .map(build);
    const node: FeatureTreeNode = { entity, children };
    if (options.expand === "chain") {
      node.blueprints = store
        .linkedFrom(entity.id, "details")
        .filter((b) => b.type === "blueprint")
        .map((blueprint) => ({
          entity: blueprint,
          workOrders: store.linkedFrom(blueprint.id, "implements").filter((w) => w.type === "work_order"),
        }));
    }
    return node;
  };

  return roots.map(build);
}
