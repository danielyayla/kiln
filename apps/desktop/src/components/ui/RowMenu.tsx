import { useState, type CSSProperties, type ReactNode } from "react";
import { color, font, radius, shadow, space } from "../../theme";

export interface RowMenuItem {
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

// Popover menu for list/tree rows (BP-6). Default trigger is the ⋯ overflow
// glyph; pass `trigger` to render something else (e.g. the board's status
// pill). Dependency-free: a fixed transparent backdrop catches outside clicks
// while the menu is open. Inside a .k-tree-row the default trigger stays
// hidden until hover/focus (index.css).
export function RowMenu({
  label,
  items,
  trigger,
  triggerStyle,
}: {
  label: string;
  items: RowMenuItem[];
  trigger?: ReactNode;
  triggerStyle?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  return (
    <span className="k-row-menu" data-open={open} style={{ position: "relative", flexShrink: 0 }}>
      <button
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        style={{
          border: "none",
          background: "transparent",
          cursor: "pointer",
          color: color.muted,
          padding: `0 ${space(1)}px`,
          borderRadius: radius.sm,
          fontSize: font.sm,
          lineHeight: 1.4,
          ...triggerStyle,
        }}
      >
        {trigger ?? "⋯"}
      </button>
      {open && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 10 }}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
          />
          <div
            role="menu"
            style={{
              position: "absolute",
              right: 0,
              top: "100%",
              zIndex: 11,
              background: color.bg,
              border: `1px solid ${color.border}`,
              borderRadius: radius.md,
              boxShadow: shadow,
              minWidth: 140,
              padding: space(1),
            }}
          >
            {items.map((item) => (
              <button
                key={item.label}
                role="menuitem"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  item.onSelect();
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: `${space(1)}px ${space(2)}px`,
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  borderRadius: radius.sm,
                  fontSize: font.sm,
                  color: item.danger ? color.danger : color.text,
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}
