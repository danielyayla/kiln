import type { Entity, EntityType, Id, SuggestionSource } from "../domain";
import type { Store } from "../store";

// The bulk-review queue: every pending suggestion in the project, grouped so
// a human can resolve a whole survey's proposals in one pass. The 2026-07-22
// dogfood run showed why grouping matters — the reviewer accepted 13 blueprint
// proposals and stopped, believing they were done, while all 14 requirement
// proposals sat unvisited. So proposals for the same feature travel together,
// REQUIREMENT FIRST, and the queue is one flat, ordered walk.
//
// Grouping rule: a blueprint belongs to the requirement it `details`; a
// requirement anchors its own group; anything else (work order, artifact)
// stands alone. Groups are ordered by the anchor entity's creation time —
// survey proposals land in tree order, so the walk mirrors the tree.

export interface ProposalItem {
  entityId: Id;
  entityType: EntityType;
  entityTitle: string;
  suggestionId: Id;
  source: SuggestionSource;
  opCount: number;
}

export interface ProposalGroup {
  // The anchor requirement's title (or the lone entity's own title) — what
  // the reviewer scans to know which feature they are deciding on.
  title: string;
  items: ProposalItem[];
}

const ROLE_ORDER: Partial<Record<EntityType, number>> = {
  requirement: 0,
  blueprint: 1,
};

export function pendingProposals(store: Store): ProposalGroup[] {
  const types: EntityType[] = ["requirement", "blueprint", "work_order", "artifact"];
  const all = types.flatMap((t) => store.listEntities(t));

  // created_at has millisecond resolution, so entities created in the same
  // tick tie; break ties by scan position (insertion order within each type)
  // so the walk is stable instead of falling to random-UUID order.
  const ordinal = new Map(all.map((e, i) => [e.id, i]));
  const byCreation = (a: Entity, b: Entity) =>
    a.createdAt.localeCompare(b.createdAt) || ordinal.get(a.id)! - ordinal.get(b.id)!;

  const pending = all
    .map((entity) => ({ entity, suggestions: store.listSuggestions(entity.id) }))
    .filter(({ suggestions }) => suggestions.length > 0);

  // anchor id -> members; the anchor entity itself may have no suggestion
  // (e.g. an accepted requirement whose blueprint is still pending).
  const groups = new Map<Id, { anchor: Entity; members: Entity[] }>();
  for (const { entity } of pending) {
    let anchor = entity;
    if (entity.type === "blueprint") {
      const detailed = store.linked(entity.id, "details").find((e) => e.type === "requirement");
      if (detailed) anchor = detailed;
    }
    const group = groups.get(anchor.id) ?? { anchor, members: [] };
    group.members.push(entity);
    groups.set(anchor.id, group);
  }

  const suggestionFor = new Map(pending.map(({ entity, suggestions }) => [entity.id, suggestions[0]]));

  return [...groups.values()]
    .sort((a, b) => byCreation(a.anchor, b.anchor))
    .map(({ anchor, members }) => ({
      title: anchor.title,
      items: members
        .sort(
          (a, b) => (ROLE_ORDER[a.type] ?? 2) - (ROLE_ORDER[b.type] ?? 2) || byCreation(a, b),
        )
        .map((entity) => {
          const suggestion = suggestionFor.get(entity.id)!;
          return {
            entityId: entity.id,
            entityType: entity.type,
            entityTitle: entity.title,
            suggestionId: suggestion.id,
            source: suggestion.source,
            opCount: suggestion.ops.length,
          };
        }),
    }));
}
