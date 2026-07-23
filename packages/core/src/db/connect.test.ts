import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "./connect";

const scratch = join(tmpdir(), `kiln-connect-test-${process.pid}`);
beforeEach(() => {
  mkdirSync(scratch, { recursive: true });
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("connect — work_type migration", () => {
  it("adds the column to a pre-migration store and backfills from title prefixes", () => {
    const path = join(scratch, "kiln.db");

    // Build a pre-migration store: create it, seed rows, then drop the
    // work_type column so the file looks like one written before BP-18.
    const old = connect(path);
    const insert = old.prepare(
      `INSERT INTO entities (id, type, title, body, status, assignee, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    );
    insert.run("wo-bug", "work_order", "[bug] Save loses edits", "done");
    insert.run("wo-chore", "work_order", "[chore] Bump deps", "draft");
    insert.run("wo-plain", "work_order", "Add the X-ray view", "done");
    insert.run("req-prefixed", "requirement", "[bug] not a work order", null);
    old.exec("ALTER TABLE entities DROP COLUMN work_type");
    old.close();

    // Re-opening migrates: column added, prefixed work orders backfilled,
    // titles untouched, non-work-orders and unprefixed rows left NULL.
    const db = connect(path);
    const rows = db
      .prepare("SELECT id, title, work_type FROM entities ORDER BY id")
      .all() as unknown as { id: string; title: string; work_type: string | null }[];
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId["wo-bug"].work_type).toBe("bug");
    expect(byId["wo-bug"].title).toBe("[bug] Save loses edits");
    expect(byId["wo-chore"].work_type).toBe("chore");
    expect(byId["wo-plain"].work_type).toBeNull();
    expect(byId["req-prefixed"].work_type).toBeNull();
    db.close();

    // A second open is a no-op — the backfill never runs again, so a value
    // deliberately cleared after migration stays cleared.
    const again = connect(path);
    again.prepare("UPDATE entities SET work_type = NULL WHERE id = 'wo-bug'").run();
    again.close();
    const third = connect(path);
    const cleared = third
      .prepare("SELECT work_type FROM entities WHERE id = 'wo-bug'")
      .get() as unknown as { work_type: string | null };
    expect(cleared.work_type).toBeNull();
    third.close();
  });
});

describe("connect — criticality migration", () => {
  it("adds the column to a pre-migration store, leaving existing rows NULL (unset)", () => {
    const path = join(scratch, "kiln.db");

    // Build a pre-migration store: create it, seed a row, then drop the
    // criticality column so the file looks like one written before the
    // verification & criticality feature.
    const old = connect(path);
    old
      .prepare(
        `INSERT INTO entities (id, type, title, body, status, work_type, assignee, created_at, updated_at)
         VALUES ('wo-1', 'work_order', 'Pre-existing', '', 'done', NULL, NULL,
                 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    old.exec("ALTER TABLE entities DROP COLUMN criticality");
    old.close();

    // Re-opening migrates: column added, no backfill — existing rows stay
    // NULL, and effectiveCriticality resolves that to routine at read time.
    const db = connect(path);
    const row = db
      .prepare("SELECT title, criticality FROM entities WHERE id = 'wo-1'")
      .get() as unknown as { title: string; criticality: string | null };
    expect(row.title).toBe("Pre-existing");
    expect(row.criticality).toBeNull();
    db.close();
  });
});
