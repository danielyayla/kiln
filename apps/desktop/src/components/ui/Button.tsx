import type { CSSProperties, ComponentProps } from "react";
import { color, font, radius, space } from "../../theme";

export type ButtonVariant = "default" | "primary" | "ghost" | "danger";

const VARIANT: Record<ButtonVariant, CSSProperties> = {
  default: { background: color.bg, border: `1px solid ${color.border}` },
  primary: { background: color.selection, border: `1px solid ${color.borderStrong}`, fontWeight: 600 },
  ghost: { background: "transparent", border: "1px solid transparent" },
  danger: { background: color.bg, border: `1px solid ${color.border}`, color: color.danger },
};

export function Button({
  variant = "default",
  style,
  ...rest
}: ComponentProps<"button"> & { variant?: ButtonVariant }) {
  return (
    <button
      {...rest}
      style={{
        padding: `${space(1)}px ${space(2.5)}px`,
        borderRadius: radius.md,
        fontSize: font.sm,
        cursor: rest.disabled ? "default" : "pointer",
        opacity: rest.disabled ? 0.5 : 1,
        ...VARIANT[variant],
        ...style,
      }}
    />
  );
}
