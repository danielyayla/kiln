import type { Entity, WorkType } from "@kiln/core";

// Local duplicates of core's tiny work-type rules (BP-18), type-checked
// against core — value imports from @kiln/core would drag node:sqlite into
// the webview bundle (same convention as Board's STATUSES literal).
export const WORK_TYPES: WorkType[] = ["feature", "bug", "refactor", "perf", "chore"];

// The one place the webview's default lives: an unset field reads as feature.
export const effectiveWorkType = (e: Pick<Entity, "workType">): WorkType => e.workType ?? "feature";

export type WorkTypeFilter = WorkType | "all";

// The Board's type filter: `all` passes everything; a concrete type matches
// by EFFECTIVE type, so filtering to `feature` includes unset work orders.
export function filterByWorkType<T extends Pick<Entity, "workType">>(items: T[], filter: WorkTypeFilter): T[] {
  return filter === "all" ? items : items.filter((item) => effectiveWorkType(item) === filter);
}
