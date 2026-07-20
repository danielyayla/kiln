import type { WorkOrderStatus } from "@kiln/core";
import { color, font } from "../../theme";

// The one status → tone mapping (BP-15). The board's pills and the
// navigator's dots both read from here so the colors can't drift.
export const STATUS_COLOR: Record<WorkOrderStatus, string> = {
  draft: color.faint,
  ready: color.warn,
  in_progress: color.info,
  done: color.ok,
  cancelled: color.danger,
};

export const STATUS_LABEL: Record<WorkOrderStatus, string> = {
  draft: "Draft",
  ready: "Ready",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Cancelled",
};

// A compact status signal for dense rows: an 8px dot carrying the status as
// its tooltip, in place of the status word.
export function StatusDot({ status }: { status: WorkOrderStatus }) {
  return (
    <span
      title={STATUS_LABEL[status]}
      aria-label={STATUS_LABEL[status]}
      role="img"
      style={{
        width: 8,
        height: 8,
        borderRadius: 999,
        background: STATUS_COLOR[status],
        flexShrink: 0,
        // Keeps the dot optically aligned with the row text.
        fontSize: font.xs,
      }}
    />
  );
}
