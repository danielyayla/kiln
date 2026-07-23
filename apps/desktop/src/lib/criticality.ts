import type { Criticality, Entity } from "@kiln/core";

// Local duplicates of core's tiny criticality rules (verification &
// criticality feature), type-checked against core — value imports from
// @kiln/core would drag node:sqlite into the webview bundle (same convention
// as work-type.ts).
export const CRITICALITIES: Criticality[] = ["routine", "important", "critical"];

// The one place the webview's default lives: an unset field reads as routine.
export const effectiveCriticality = (e: Pick<Entity, "criticality">): Criticality =>
  e.criticality ?? "routine";

export type CriticalityFilter = Criticality | "all";

// The Board's criticality filter: `all` passes everything; a concrete level
// matches by EFFECTIVE criticality, so filtering to `routine` includes unset
// work orders.
export function filterByCriticality<T extends Pick<Entity, "criticality">>(
  items: T[],
  filter: CriticalityFilter,
): T[] {
  return filter === "all" ? items : items.filter((item) => effectiveCriticality(item) === filter);
}
