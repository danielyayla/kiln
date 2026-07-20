import { type WorkOrderStatus } from "./domain";

// The work-order status lifecycle from BP-3, shared by every consumer (the
// MCP bridge and the workspace board) so the rule has one home:
//   draft → ready → in_progress → done, plus  * → cancelled.
// Forward edges only; `cancelled` is added separately as a universal escape hatch.
const FORWARD: Record<WorkOrderStatus, WorkOrderStatus[]> = {
  draft: ["ready"],
  ready: ["in_progress"],
  in_progress: ["done"],
  done: [],
  cancelled: [],
};

// A work order with no explicit status is treated as a fresh `draft` for the
// purpose of validating transitions.
export const DEFAULT_STATUS: WorkOrderStatus = "draft";

// The statuses a work order may legally move to from `from`. Any non-cancelled
// state may be cancelled (`*→cancelled`); `cancelled` itself is terminal.
export function allowedNextStatuses(from: WorkOrderStatus): WorkOrderStatus[] {
  const forward = FORWARD[from] ?? [];
  return from === "cancelled" ? [...forward] : [...forward, "cancelled"];
}

// A transition is valid only if `to` is a reachable next state. A no-op
// (`from === to`) is not a transition and is rejected.
export function canTransition(from: WorkOrderStatus, to: WorkOrderStatus): boolean {
  if (from === to) return false;
  return allowedNextStatuses(from).includes(to);
}
