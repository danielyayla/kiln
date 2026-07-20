import type { FeatureTreeNode } from "@kiln/core";

// Work-order rollup for one navigator subtree (BP-15): done / non-cancelled
// across the requirement's blueprints' work orders and all child requirements.
// Null status counts as draft (the board convention); cancelled work leaves
// the denominator. Pure — the tree data already carries every entity needed.
export interface TreeProgress {
  done: number;
  total: number;
}

export function treeProgress(node: FeatureTreeNode): TreeProgress {
  let done = 0;
  let total = 0;
  for (const bp of node.blueprints ?? []) {
    for (const wo of bp.workOrders) {
      const status = wo.status ?? "draft";
      if (status === "cancelled") continue;
      total += 1;
      if (status === "done") done += 1;
    }
  }
  for (const child of node.children) {
    const sub = treeProgress(child);
    done += sub.done;
    total += sub.total;
  }
  return { done, total };
}

// The Phase 14 product-root convention, read off the navigator tree the same
// way assignLanes reads it off the snapshot: exactly one root requirement,
// and it has requirement children. Null for flat stores — the sidebar then
// renders exactly as before.
export function productRootNode(tree: FeatureTreeNode[]): FeatureTreeNode | null {
  return tree.length === 1 && tree[0].children.length > 0 ? tree[0] : null;
}
