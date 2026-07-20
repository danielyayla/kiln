import type { ComponentProps } from "react";
import { color, font, radius, space } from "../../theme";

export function Input({ style, ...rest }: ComponentProps<"input">) {
  return (
    <input
      {...rest}
      style={{
        padding: `${space(1)}px ${space(2)}px`,
        border: `1px solid ${color.border}`,
        borderRadius: radius.md,
        background: color.bg,
        fontSize: font.sm,
        ...style,
      }}
    />
  );
}
