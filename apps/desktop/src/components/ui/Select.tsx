import type { ComponentProps } from "react";
import { color, font, radius, space } from "../../theme";

export function Select({ style, ...rest }: ComponentProps<"select">) {
  return (
    <select
      {...rest}
      style={{
        padding: `${space(1)}px ${space(1.5)}px`,
        border: `1px solid ${color.border}`,
        borderRadius: radius.md,
        background: color.bg,
        fontSize: font.sm,
        cursor: rest.disabled ? "default" : "pointer",
        ...style,
      }}
    />
  );
}
