// Token layer (BP-6). Colors resolve to the CSS variables defined in
// index.css — the only file allowed to contain raw hex. Components style
// inline from these tokens; nothing outside this layer hard-codes a color,
// font size, spacing value, or radius.

export const color = {
  bg: "var(--k-bg)",
  surface: "var(--k-surface)",
  inset: "var(--k-inset)",
  selection: "var(--k-selection)",
  chip: "var(--k-chip)",
  border: "var(--k-border)",
  borderStrong: "var(--k-border-strong)",
  text: "var(--k-text)",
  muted: "var(--k-muted)",
  faint: "var(--k-faint)",
  danger: "var(--k-danger)",
  dangerSurface: "var(--k-danger-surface)",
  accent: "var(--k-accent)",
  ok: "var(--k-ok)",
  warn: "var(--k-warn)",
  info: "var(--k-bp-fg)",
  // Diff/decision colors (match the .kiln-ins/.kiln-del editor decorations)
  ins: "var(--k-ins-fg)",
  del: "var(--k-del-fg)",
} as const;

// Type scale. xs = badges/fine print, sm = secondary text/controls,
// base = body, lg = section titles. (Document titles use the h2 default.)
export const font = {
  xs: "0.7rem",
  sm: "0.8rem",
  base: "0.9rem",
  lg: "1.1rem",
} as const;

// 4px spacing grid.
export const space = (n: number): number => n * 4;

export const radius = {
  sm: 4,
  md: 6,
  lg: 8,
} as const;

export const shadow = "var(--k-shadow)";
export const backdrop = "var(--k-backdrop)";
