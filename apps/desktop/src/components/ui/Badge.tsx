import type { EntityType } from "@kiln/core";
import { font, radius } from "../../theme";

// Entity-type badge (REQ / BP / WO / ART). Colors come from the badge
// variables in index.css so the tree, graph panel, board, and quick-open all
// render types identically.
const BADGE: Record<EntityType, { label: string; fg: string; bg: string }> = {
  requirement: { label: "REQ", fg: "var(--k-req-fg)", bg: "var(--k-req-bg)" },
  blueprint: { label: "BP", fg: "var(--k-bp-fg)", bg: "var(--k-bp-bg)" },
  work_order: { label: "WO", fg: "var(--k-wo-fg)", bg: "var(--k-wo-bg)" },
  artifact: { label: "ART", fg: "var(--k-art-fg)", bg: "var(--k-art-bg)" },
};

export function Badge({ type }: { type: EntityType }) {
  const b = BADGE[type];
  return (
    <span
      style={{
        fontSize: font.xs,
        fontWeight: 700,
        letterSpacing: "0.04em",
        color: b.fg,
        background: b.bg,
        borderRadius: radius.sm,
        padding: "1px 5px",
        flexShrink: 0,
      }}
    >
      {b.label}
    </span>
  );
}
