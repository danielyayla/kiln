// Board view gating: which top-level state the board renders for the
// work-orders query. Pending must show a loading affordance and error a
// sidecar-style error — never the columns, whose per-column empty hints
// ("Extract work orders…") would make a dead sidecar look like an
// empty-but-healthy board. Columns (and their hints) render only after the
// query has succeeded.
export type BoardViewState = "loading" | "error" | "board";

export function boardViewState(query: { isPending: boolean; isError: boolean }): BoardViewState {
  if (query.isPending) return "loading";
  if (query.isError) return "error";
  return "board";
}
