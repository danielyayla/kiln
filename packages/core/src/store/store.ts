import type {
  ContextReceipt,
  Entity,
  EntityPatch,
  EntityType,
  Id,
  Link,
  LinkType,
  ModelUsage,
  NewEntity,
  NewModelUsage,
  Revision,
  Suggestion,
  WorkOrderStatus,
} from "../domain";

// The one seam every consumer uses. Nothing outside a Store implementation may
// import better-sqlite3 or write SQL — that is what keeps a future PostgresStore
// (for the hosted tier) a drop-in replacement.
export interface Store {
  createEntity(input: NewEntity): Entity;
  getEntity(id: Id): Entity | null;
  // Refuses a body change while suggestions are pending on the entity
  // (ConstraintError) — their ops are anchored to the current body. Resolve
  // via applySuggestion or dismiss via deleteSuggestion first.
  updateEntity(id: Id, patch: EntityPatch): Entity;
  listEntities(type: EntityType): Entity[];
  // Deletes the entity and, via ON DELETE CASCADE, every link/suggestion/
  // revision that referenced it. Throws if the entity does not exist.
  deleteEntity(id: Id): void;

  link(fromId: Id, toId: Id, type: LinkType): void;
  unlink(fromId: Id, toId: Id, type: LinkType): void;
  linked(id: Id, type: LinkType): Entity[];      // entities `to` where (id -> to, type)
  linkedFrom(id: Id, type: LinkType): Entity[];  // entities `from` where (from -> id, type)
  listLinks(): Link[];                            // every edge, for whole-graph reads (Phase 7)

  children(parentId: Id): Entity[];
  subtree(rootId: Id): Entity[];

  workOrdersByStatus(status: WorkOrderStatus): Entity[];

  saveSuggestion(s: Suggestion): void;
  getSuggestion(id: Id): Suggestion | null;
  listSuggestions(targetId: Id): Suggestion[];
  deleteSuggestion(id: Id): void;
  listRevisions(entityId: Id): Revision[];

  // Context provenance (Phase 8): immutable snapshots of the context handed to
  // an agent for a work order. `list` is chronological (oldest first); `latest`
  // is the most recent by insertion order.
  saveContextReceipt(receipt: ContextReceipt): void;
  listContextReceipts(workOrderId: Id): ContextReceipt[];
  latestContextReceipt(workOrderId: Id): ContextReceipt | null;

  // AI settings & usage: host-level configuration as opaque string values —
  // booleans are stored "true"/"false" and parsed at the consumer boundary.
  // The sidecar keeps the API key under a settings key; masking is the
  // sidecar's job, never the store's.
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;   // upsert
  deleteSetting(key: string): void;               // idempotent on a missing key

  // The model-call ledger: one entry per completed model call (token counts
  // only). `list` is insertion order (oldest first); `since` is an inclusive
  // ISO-timestamp lower bound.
  recordModelUsage(input: NewModelUsage): ModelUsage;
  listModelUsage(opts?: { since?: string }): ModelUsage[];

  // Atomically set an entity's body and append a revision snapshotting the
  // new body — both happen or neither does. This is the only way document
  // edits are committed (BP-4); plain updateEntity writes no revision.
  commitBody(entityId: Id, body: string): { entity: Entity; revision: Revision };

  searchArtifacts(query: string): Entity[];

  close(): void;
}
