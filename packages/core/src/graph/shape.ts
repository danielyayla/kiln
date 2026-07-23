import type { Store } from "../store";
import { DESIGN_DOC_TEMPLATE } from "../seed";
import { rootRequirements } from "./roots";

// The one-call populated-project signal for surveying agents (Brownfield
// extraction, benchmark finding 2): over MCP, list_ready_work_orders cannot
// distinguish a populated project with no ready work from a fresh one. This
// helper classifies the store's shape deterministically so the kiln-survey
// pre-flight check is real instead of leaning on human confirmation.
//
// - "empty":     no entities at all (a store that was never seeded).
// - "fresh":     exactly the seeded pair — one parentless requirement with an
//                empty body, its one pristine `details` blueprint (empty or
//                the fill-in DESIGN_DOC_TEMPLATE), nothing else, and no
//                pending suggestions. Safe to survey into.
// - "populated": anything else — someone (human or prior survey) already owns
//                part of the graph.

export type ProjectShapeKind = "empty" | "fresh" | "populated";

export interface ProjectShape {
  shape: ProjectShapeKind;
  // The single parentless requirement's title; null when there are none or
  // several (the count disambiguates which).
  rootTitle: string | null;
  counts: {
    requirements: number;
    blueprints: number;
    workOrders: number;
    artifacts: number;
  };
  pendingSuggestions: number;
}

const pristine = (body: string) => body.trim() === "" || body === DESIGN_DOC_TEMPLATE;

export function projectShape(store: Store): ProjectShape {
  const requirements = store.listEntities("requirement");
  const blueprints = store.listEntities("blueprint");
  const workOrders = store.listEntities("work_order");
  const artifacts = store.listEntities("artifact");
  const all = [...requirements, ...blueprints, ...workOrders, ...artifacts];

  const pendingSuggestions = all.reduce(
    (sum, entity) => sum + store.listSuggestions(entity.id).length,
    0,
  );

  const roots = rootRequirements(store);
  const rootTitle = roots.length === 1 ? roots[0].title : null;

  let shape: ProjectShapeKind;
  if (all.length === 0) {
    shape = "empty";
  } else if (
    roots.length === 1 &&
    requirements.length === 1 &&
    workOrders.length === 0 &&
    artifacts.length === 0 &&
    pendingSuggestions === 0 &&
    pristine(roots[0].body) &&
    blueprints.length === 1 &&
    pristine(blueprints[0].body) &&
    store.linked(blueprints[0].id, "details").some((e) => e.id === roots[0].id)
  ) {
    shape = "fresh";
  } else {
    shape = "populated";
  }

  return {
    shape,
    rootTitle,
    counts: {
      requirements: requirements.length,
      blueprints: blueprints.length,
      workOrders: workOrders.length,
      artifacts: artifacts.length,
    },
    pendingSuggestions,
  };
}
