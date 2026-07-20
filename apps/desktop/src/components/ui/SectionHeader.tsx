import type { CSSProperties, ReactNode } from "react";
import { color, font, space } from "../../theme";

// Uppercase muted section heading. size "md" = sidebar/panel sections (h2),
// size "sm" = subsections inside a panel (h3).
export function SectionHeader({
  size = "md",
  style,
  children,
}: {
  size?: "md" | "sm";
  style?: CSSProperties;
  children: ReactNode;
}) {
  const Tag = size === "md" ? "h2" : "h3";
  return (
    <Tag
      style={{
        fontSize: size === "md" ? font.base : font.xs,
        textTransform: "uppercase",
        letterSpacing: size === "md" ? undefined : "0.06em",
        color: color.muted,
        margin: `0 0 ${space(1.5)}px`,
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}
