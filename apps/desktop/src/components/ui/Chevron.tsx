import { color, font } from "../../theme";

// Purely visual disclosure triangle — wrap it in whatever button toggles.
export function Chevron({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 12,
        fontSize: font.xs,
        color: color.muted,
        transform: open ? "rotate(90deg)" : "none",
        transition: "transform 120ms",
      }}
    >
      ▶
    </span>
  );
}
