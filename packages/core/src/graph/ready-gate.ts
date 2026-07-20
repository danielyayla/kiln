import type { Id } from "../domain";
import type { Store } from "../store";
import { documentHealth } from "./document-health";
import type { HealthCheck } from "./health";

// Layer 3 of the authoring-methodology enforcement ladder: the draft→ready
// completeness gate, work orders only. The gate is a SELECTION over
// documentHealth, not new rules — every error-level check blocks, plus the
// warns without which a handoff is meaningless. Empty result = pass.
// Enforcement (and any override) belongs to the write surfaces;
// canTransition stays a pure status-graph rule.
const BLOCKING_WARNS = new Set(["missing-implements", "empty-body", "missing-acceptance-criteria"]);

export function readyGateBlockers(store: Store, id: Id): HealthCheck[] {
  return documentHealth(store, id).checks.filter((c) => c.level === "error" || BLOCKING_WARNS.has(c.code));
}
