import { color, font, radius } from "../../theme";

// Dependency-blocked marker (danger tokens). One source of truth so the
// board and the Context Inspector render blocked-ness identically (BP-17).
export function BlockedBadge({ title }: { title?: string }) {
  return (
    <span
      data-testid="blocked-badge"
      title={title}
      style={{
        fontSize: font.xs,
        fontWeight: 700,
        letterSpacing: "0.04em",
        color: color.danger,
        background: color.dangerSurface,
        borderRadius: radius.sm,
        padding: "1px 5px",
        flexShrink: 0,
      }}
    >
      BLOCKED
    </span>
  );
}
