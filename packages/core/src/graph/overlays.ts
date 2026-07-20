import type { Id } from "../domain";
import type { Store } from "../store";
import { rootRequirements } from "./roots";

// Diagnostic overlays for the Project X-ray (Phase 7). Both are pure over the
// Store; the sidecar serves them and the Map view highlights the results.

// Structural dead-ends — where intent stops flowing toward code.
export interface GraphGaps {
  // Requirements no blueprint details.
  requirements: Id[];
  // Blueprints no work order implements.
  blueprints: Id[];
  // Artifacts nothing references.
  artifacts: Id[];
}

export function graphGaps(store: Store): GraphGaps {
  // Product-root docs are reference material, not pipeline stages (Phase 16):
  // the root requirement is never "missing a blueprint" in the
  // feature-pipeline sense, and its architecture blueprints (the project
  // design doc) are never meant to be implemented directly — flagging them
  // would be a permanent false positive (and would put this overlay out of
  // step with Pulse, which rolls up gaps per feature and never counts the
  // root). The exemption keys off the UNIQUE parentless requirement — the
  // product root — WHETHER OR NOT it has feature children yet, so a freshly
  // seeded project (root + design doc, no features) has its design doc exempt
  // from the first minute, not only once a feature is added. A flat store
  // (multiple parentless requirements) has no single root => no exemption.
  const roots = rootRequirements(store);
  const root = roots.length === 1 ? roots[0] : null;
  const rootBlueprints = new Set(
    root ? store.linkedFrom(root.id, "details").map((b) => b.id) : [],
  );

  // A feature-level design doc is "covered" when the implementing work is
  // recorded under child requirements (the phases-into-features shape,
  // 2026-07-11): its own requirement's DESCENDANTS own implemented blueprints,
  // so flagging it as blueprint-without-work-order would be a permanent false
  // positive for every built feature. Descendants only — a sibling blueprint
  // on the same requirement does not cover it, and flat stores (no child_of)
  // are unaffected.
  const blueprints = store.listEntities("blueprint");
  const implementedReqs = new Set(
    blueprints
      .filter((b) => store.linkedFrom(b.id, "implements").length > 0)
      .flatMap((b) => store.linked(b.id, "details").map((r) => r.id)),
  );
  const coveredByDescendants = (bpId: Id): boolean => {
    const req = store.linked(bpId, "details")[0];
    if (!req) return false;
    return store
      .subtree(req.id)
      .some((e) => e.id !== req.id && e.type === "requirement" && implementedReqs.has(e.id));
  };

  return {
    requirements: store
      .listEntities("requirement")
      .filter((r) => r.id !== root?.id && store.linkedFrom(r.id, "details").length === 0)
      .map((r) => r.id),
    blueprints: blueprints
      .filter(
        (b) =>
          !rootBlueprints.has(b.id) &&
          store.linkedFrom(b.id, "implements").length === 0 &&
          !coveredByDescendants(b.id),
      )
      .map((b) => b.id),
    artifacts: store
      .listEntities("artifact")
      .filter((a) => store.linkedFrom(a.id, "references").length === 0)
      .map((a) => a.id),
  };
}

// The longest chain of unfinished work orders linked by depends_on — the
// critical path of remaining work. Returns the ordered ids (each depends_on the
// next). Traversal is restricted to unfinished (not done/cancelled) work orders,
// memoized, and cycle-guarded so a pathological depends_on loop terminates.
// Deterministic tie-breaking by id keeps reruns stable.
export function criticalPath(store: Store): Id[] {
  const active = new Set(
    store
      .listEntities("work_order")
      .filter((w) => w.status !== "done" && w.status !== "cancelled")
      .map((w) => w.id),
  );

  const depsOf = (id: Id): Id[] =>
    store
      .linked(id, "depends_on")
      .filter((t) => active.has(t.id))
      .map((t) => t.id)
      .sort();

  const len = new Map<Id, number>();
  const next = new Map<Id, Id | null>();
  const visiting = new Set<Id>();

  const longest = (id: Id): number => {
    const cached = len.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 1; // cycle: break without memoizing
    visiting.add(id);
    let bestLen = 1;
    let bestNext: Id | null = null;
    for (const d of depsOf(id)) {
      const l = 1 + longest(d);
      if (l > bestLen) {
        bestLen = l;
        bestNext = d;
      }
    }
    visiting.delete(id);
    len.set(id, bestLen);
    next.set(id, bestNext);
    return bestLen;
  };

  let start: Id | null = null;
  let best = 0;
  for (const id of [...active].sort()) {
    const l = longest(id);
    if (l > best) {
      best = l;
      start = id;
    }
  }

  const path: Id[] = [];
  const seen = new Set<Id>();
  let cur = start;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    path.push(cur);
    cur = next.get(cur) ?? null;
  }
  return path;
}
