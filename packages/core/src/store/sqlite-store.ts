import { randomUUID } from "node:crypto";
import { connect, type DB } from "../db/connect";
import {
  CompletionReceipt,
  EntityPatch,
  NewEntity,
  NewModelUsage,
  Suggestion,
  type ContextReceipt,
  type Entity,
  type EntityType,
  type Id,
  type Link,
  type LinkType,
  type ModelUsage,
  type Revision,
  type WorkOrderStatus,
} from "../domain";
import { ConstraintError, NotFoundError } from "../errors";
import type { Store } from "./store";

interface EntityRow {
  id: string;
  type: string;
  title: string;
  body: string;
  status: string | null;
  assignee: string | null;
  created_at: string;
  updated_at: string;
}

function toEntity(r: EntityRow): Entity {
  return {
    id: r.id,
    type: r.type as Entity["type"],
    title: r.title,
    body: r.body,
    status: (r.status as WorkOrderStatus | null) ?? null,
    assignee: r.assignee ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface ContextReceiptRow {
  id: string;
  work_order_id: string;
  context_json: string;
  hash: string;
  created_at: string;
}

function toContextReceipt(r: ContextReceiptRow): ContextReceipt {
  return {
    id: r.id,
    workOrderId: r.work_order_id,
    context: JSON.parse(r.context_json),
    hash: r.hash,
    createdAt: r.created_at,
  };
}

interface CompletionReceiptRow {
  id: string;
  work_order_id: string;
  summary: string;
  verification: string;
  commits_json: string;
  branch: string | null;
  files_touched_json: string;
  created_at: string;
}

function toCompletionReceipt(r: CompletionReceiptRow): CompletionReceipt {
  const receipt: CompletionReceipt = {
    id: r.id,
    workOrderId: r.work_order_id,
    summary: r.summary,
    verification: r.verification,
    commits: JSON.parse(r.commits_json),
    filesTouched: JSON.parse(r.files_touched_json),
    createdAt: r.created_at,
  };
  if (r.branch !== null) receipt.branch = r.branch;
  return receipt;
}

interface ModelUsageRow {
  id: string;
  feature: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  created_at: string;
}

function toModelUsage(r: ModelUsageRow): ModelUsage {
  return {
    id: r.id,
    feature: r.feature as ModelUsage["feature"],
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    createdAt: r.created_at,
  };
}

export class SqliteStore implements Store {
  private db: DB;

  constructor(path = ":memory:") {
    this.db = connect(path);
  }

  close(): void {
    this.db.close();
  }

  createEntity(input: NewEntity): Entity {
    const data = NewEntity.parse(input);
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO entities (id, type, title, body, status, assignee, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, data.type, data.title, data.body, data.status ?? null, data.assignee ?? null, now, now);
    this.syncFts(id);
    return this.getEntity(id)!;
  }

  getEntity(id: Id): Entity | null {
    const row = this.db.prepare(`SELECT * FROM entities WHERE id = ?`).get(id) as unknown as
      | EntityRow
      | undefined;
    return row ? toEntity(row) : null;
  }

  listEntities(type: EntityType): Entity[] {
    const rows = this.db
      .prepare(`SELECT * FROM entities WHERE type = ? ORDER BY created_at`)
      .all(type) as unknown as EntityRow[];
    return rows.map(toEntity);
  }

  deleteEntity(id: Id): void {
    if (!this.getEntity(id)) throw new NotFoundError(id);
    // Foreign keys are ON (see connect.ts), so ON DELETE CASCADE removes the
    // entity's links, suggestions, and revisions in the same statement.
    this.db.prepare(`DELETE FROM entities WHERE id = ?`).run(id);
    this.db.prepare(`DELETE FROM entities_fts WHERE id = ?`).run(id);
  }

  updateEntity(id: Id, patch: EntityPatch): Entity {
    const data = EntityPatch.parse(patch);
    const existing = this.getEntity(id);
    if (!existing) throw new NotFoundError(id);
    // Anchor lock: suggestion ops are anchored to the current body, so a
    // direct body edit while suggestions are pending would silently break
    // them. Resolve or dismiss first — resolution itself goes through
    // commitBody, which this guard does not touch.
    if (data.body !== undefined && data.body !== existing.body) {
      const pending = this.listSuggestions(id).length;
      if (pending > 0) {
        throw new ConstraintError(
          `entity ${id} has ${pending} pending suggestion(s); resolve or dismiss them before editing the body`,
        );
      }
    }
    this.db
      .prepare(
        `UPDATE entities SET title=?, body=?, status=?, assignee=?, updated_at=? WHERE id=?`,
      )
      .run(
        data.title ?? existing.title,
        data.body ?? existing.body,
        data.status !== undefined ? data.status : existing.status,
        data.assignee !== undefined ? data.assignee : existing.assignee,
        new Date().toISOString(),
        id,
      );
    this.syncFts(id);
    return this.getEntity(id)!;
  }

  link(fromId: Id, toId: Id, type: LinkType): void {
    if (!this.getEntity(fromId)) throw new NotFoundError(fromId);
    if (!this.getEntity(toId)) throw new NotFoundError(toId);
    if (type === "details") {
      const existing = this.db
        .prepare(`SELECT COUNT(*) AS n FROM links WHERE from_id=? AND type='details'`)
        .get(fromId) as unknown as { n: number };
      if (existing.n > 0) {
        throw new ConstraintError(`blueprint ${fromId} already details a requirement (1:1)`);
      }
    }
    this.db
      .prepare(`INSERT OR IGNORE INTO links (from_id, to_id, type) VALUES (?, ?, ?)`)
      .run(fromId, toId, type);
  }

  unlink(fromId: Id, toId: Id, type: LinkType): void {
    this.db.prepare(`DELETE FROM links WHERE from_id=? AND to_id=? AND type=?`).run(fromId, toId, type);
  }

  listLinks(): Link[] {
    const rows = this.db
      .prepare(`SELECT from_id, to_id, type FROM links ORDER BY type, from_id, to_id`)
      .all() as unknown as { from_id: string; to_id: string; type: LinkType }[];
    return rows.map((r) => ({ fromId: r.from_id, toId: r.to_id, type: r.type }));
  }

  linked(id: Id, type: LinkType): Entity[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM links l JOIN entities e ON e.id = l.to_id
         WHERE l.from_id = ? AND l.type = ? ORDER BY e.created_at`,
      )
      .all(id, type) as unknown as EntityRow[];
    return rows.map(toEntity);
  }

  linkedFrom(id: Id, type: LinkType): Entity[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM links l JOIN entities e ON e.id = l.from_id
         WHERE l.to_id = ? AND l.type = ? ORDER BY e.created_at`,
      )
      .all(id, type) as unknown as EntityRow[];
    return rows.map(toEntity);
  }

  children(parentId: Id): Entity[] {
    // child_of points child -> parent, so children are the `from` side where to = parent
    return this.linkedFrom(parentId, "child_of");
  }

  subtree(rootId: Id): Entity[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE sub(id) AS (
           SELECT ?
           UNION
           SELECT l.from_id FROM links l JOIN sub ON l.to_id = sub.id AND l.type = 'child_of'
         )
         SELECT e.* FROM entities e JOIN sub ON e.id = sub.id ORDER BY e.created_at`,
      )
      .all(rootId) as unknown as EntityRow[];
    return rows.map(toEntity);
  }

  workOrdersByStatus(status: WorkOrderStatus): Entity[] {
    const rows = this.db
      .prepare(`SELECT * FROM entities WHERE type='work_order' AND status=? ORDER BY created_at`)
      .all(status) as unknown as EntityRow[];
    return rows.map(toEntity);
  }

  saveSuggestion(s: Suggestion): void {
    const data = Suggestion.parse(s);
    if (!this.getEntity(data.targetId)) throw new NotFoundError(data.targetId);
    this.db
      .prepare(
        `INSERT INTO suggestions (id, target_id, source, ops_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(data.id, data.targetId, data.source, JSON.stringify(data.ops), new Date().toISOString());
  }

  getSuggestion(id: Id): Suggestion | null {
    const row = this.db.prepare(`SELECT * FROM suggestions WHERE id = ?`).get(id) as unknown as
      | { id: string; target_id: string; source: string; ops_json: string }
      | undefined;
    if (!row) return null;
    return Suggestion.parse({
      id: row.id,
      targetId: row.target_id,
      source: row.source,
      ops: JSON.parse(row.ops_json),
    });
  }

  listSuggestions(targetId: Id): Suggestion[] {
    const rows = this.db
      .prepare(`SELECT * FROM suggestions WHERE target_id=? ORDER BY created_at`)
      .all(targetId) as unknown as { id: string; target_id: string; source: string; ops_json: string }[];
    return rows.map((r) =>
      Suggestion.parse({
        id: r.id,
        targetId: r.target_id,
        source: r.source,
        ops: JSON.parse(r.ops_json),
      }),
    );
  }

  deleteSuggestion(id: Id): void {
    this.db.prepare(`DELETE FROM suggestions WHERE id = ?`).run(id);
  }

  listRevisions(entityId: Id): Revision[] {
    const rows = this.db
      .prepare(`SELECT * FROM revisions WHERE entity_id=? ORDER BY created_at`)
      .all(entityId) as unknown as { id: string; entity_id: string; body: string; created_at: string }[];
    return rows.map((r) => ({
      id: r.id,
      entityId: r.entity_id,
      body: r.body,
      createdAt: r.created_at,
    }));
  }

  saveContextReceipt(receipt: ContextReceipt): void {
    if (!this.getEntity(receipt.workOrderId)) throw new NotFoundError(receipt.workOrderId);
    this.db
      .prepare(
        `INSERT INTO context_receipts (id, work_order_id, context_json, hash, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(receipt.id, receipt.workOrderId, JSON.stringify(receipt.context), receipt.hash, receipt.createdAt);
  }

  // rowid ordering is the true insertion order, robust to created_at ties within
  // a millisecond (unlike a UUID id, which is not monotonic).
  listContextReceipts(workOrderId: Id): ContextReceipt[] {
    const rows = this.db
      .prepare(`SELECT * FROM context_receipts WHERE work_order_id=? ORDER BY rowid`)
      .all(workOrderId) as unknown as ContextReceiptRow[];
    return rows.map(toContextReceipt);
  }

  latestContextReceipt(workOrderId: Id): ContextReceipt | null {
    const row = this.db
      .prepare(`SELECT * FROM context_receipts WHERE work_order_id=? ORDER BY rowid DESC LIMIT 1`)
      .get(workOrderId) as unknown as ContextReceiptRow | undefined;
    return row ? toContextReceipt(row) : null;
  }

  saveCompletionReceipt(receipt: CompletionReceipt): void {
    const data = CompletionReceipt.parse(receipt);
    if (!this.getEntity(data.workOrderId)) throw new NotFoundError(data.workOrderId);
    this.db
      .prepare(
        `INSERT INTO completion_receipts
           (id, work_order_id, summary, verification, commits_json, branch, files_touched_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.id,
        data.workOrderId,
        data.summary,
        data.verification,
        JSON.stringify(data.commits),
        data.branch ?? null,
        JSON.stringify(data.filesTouched),
        data.createdAt,
      );
  }

  // rowid ordering as for context receipts: true insertion order, robust to
  // created_at ties. Deliberately no latest* — completion receipts are never
  // deduped; every close is its own record.
  listCompletionReceipts(workOrderId: Id): CompletionReceipt[] {
    const rows = this.db
      .prepare(`SELECT * FROM completion_receipts WHERE work_order_id=? ORDER BY rowid`)
      .all(workOrderId) as unknown as CompletionReceiptRow[];
    return rows.map(toCompletionReceipt);
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as unknown as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  deleteSetting(key: string): void {
    this.db.prepare(`DELETE FROM settings WHERE key = ?`).run(key);
  }

  recordModelUsage(input: NewModelUsage): ModelUsage {
    const data = NewModelUsage.parse(input);
    const entry: ModelUsage = { id: randomUUID(), ...data, createdAt: new Date().toISOString() };
    this.db
      .prepare(
        `INSERT INTO model_usage (id, feature, model, input_tokens, output_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(entry.id, entry.feature, entry.model, entry.inputTokens, entry.outputTokens, entry.createdAt);
    return entry;
  }

  // rowid ordering is the true insertion order (same rationale as receipts);
  // `since` compares ISO strings, which order lexicographically.
  listModelUsage(opts: { since?: string } = {}): ModelUsage[] {
    const rows = (
      opts.since === undefined
        ? this.db.prepare(`SELECT * FROM model_usage ORDER BY rowid`).all()
        : this.db.prepare(`SELECT * FROM model_usage WHERE created_at >= ? ORDER BY rowid`).all(opts.since)
    ) as unknown as ModelUsageRow[];
    return rows.map(toModelUsage);
  }

  commitBody(entityId: Id, body: string): { entity: Entity; revision: Revision } {
    const existing = this.getEntity(entityId);
    if (!existing) throw new NotFoundError(entityId);
    const now = new Date().toISOString();
    const revisionId = randomUUID();
    // One transaction covers both writes: the body update and its revision
    // snapshot land together or not at all.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`UPDATE entities SET body=?, updated_at=? WHERE id=?`).run(body, now, entityId);
      this.db
        .prepare(`INSERT INTO revisions (id, entity_id, body, created_at) VALUES (?, ?, ?, ?)`)
        .run(revisionId, entityId, body, now);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.syncFts(entityId);
    return {
      entity: this.getEntity(entityId)!,
      revision: { id: revisionId, entityId, body, createdAt: now },
    };
  }

  searchArtifacts(query: string): Entity[] {
    const rows = this.db
      .prepare(
        `SELECT e.* FROM entities_fts
         JOIN entities e ON e.id = entities_fts.id
         WHERE entities_fts MATCH ? AND entities_fts.type = 'artifact'
         ORDER BY rank`,
      )
      .all(query) as unknown as EntityRow[];
    return rows.map(toEntity);
  }

  private syncFts(id: Id): void {
    const e = this.getEntity(id);
    if (!e) return;
    this.db.prepare(`DELETE FROM entities_fts WHERE id = ?`).run(id);
    this.db
      .prepare(`INSERT INTO entities_fts (id, type, title, body) VALUES (?, ?, ?, ?)`)
      .run(e.id, e.type, e.title, e.body);
  }
}
