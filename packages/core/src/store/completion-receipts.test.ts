import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "../db/connect";
import { NotFoundError } from "../errors";
import { SqliteStore } from "./sqlite-store";
import type { CompletionReceipt } from "../domain";

let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore(":memory:");
});
afterEach(() => store.close());

function receipt(workOrderId: string, summary: string, extra: Partial<CompletionReceipt> = {}): CompletionReceipt {
  return {
    id: randomUUID(),
    workOrderId,
    summary,
    verification: "pnpm -C packages/core test — all green",
    commits: [],
    filesTouched: [],
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

describe("completion receipts", () => {
  it("saves a receipt and reads it back, lists round-tripping through JSON", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "done" });
    const r = receipt(wo.id, "built the thing", {
      commits: ["abc123", "def456"],
      branch: "feature/receipts",
      filesTouched: ["src/a.ts", "src/b.ts"],
    });
    store.saveCompletionReceipt(r);

    const list = store.listCompletionReceipts(wo.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(r);
  });

  it("omits branch when the receipt was saved without one", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "done" });
    store.saveCompletionReceipt(receipt(wo.id, "no branch testimony"));

    const [r] = store.listCompletionReceipts(wo.id);
    expect(r.branch).toBeUndefined();
    expect(r.commits).toEqual([]);
    expect(r.filesTouched).toEqual([]);
  });

  it("lists receipts in insertion order (append-only, never deduped)", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "done" });
    store.saveCompletionReceipt(receipt(wo.id, "first"));
    store.saveCompletionReceipt(receipt(wo.id, "second"));
    store.saveCompletionReceipt(receipt(wo.id, "third"));

    // Ordered oldest→newest even when created_at ties within a millisecond
    // (rowid is the true insertion order).
    expect(store.listCompletionReceipts(wo.id).map((r) => r.summary)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("scopes receipts to their work order", () => {
    const a = store.createEntity({ type: "work_order", title: "A", status: "done" });
    const b = store.createEntity({ type: "work_order", title: "B", status: "done" });
    store.saveCompletionReceipt(receipt(a.id, "for a"));

    expect(store.listCompletionReceipts(a.id)).toHaveLength(1);
    expect(store.listCompletionReceipts(b.id)).toEqual([]);
  });

  it("refuses a receipt for an unknown work order", () => {
    expect(() => store.saveCompletionReceipt(receipt("does-not-exist", "s"))).toThrow(NotFoundError);
  });

  it("cascades receipts when the work order is deleted", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "done" });
    store.saveCompletionReceipt(receipt(wo.id, "s"));
    store.deleteEntity(wo.id);
    expect(store.listCompletionReceipts(wo.id)).toEqual([]);
  });
});

describe("completion_receipts migration", () => {
  const scratch = join(tmpdir(), `kiln-completion-migration-${process.pid}`);
  const dbPath = join(scratch, "kiln.db");

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("adds the table to an existing database without touching existing tables or data", () => {
    // An "older" database: full schema minus completion_receipts, with data.
    mkdirSync(scratch, { recursive: true });
    const seeded = new SqliteStore(dbPath);
    const wo = seeded.createEntity({ type: "work_order", title: "pre-existing", status: "done" });
    seeded.saveContextReceipt({
      id: randomUUID(),
      workOrderId: wo.id,
      context: { kept: true },
      hash: "h1",
      createdAt: new Date().toISOString(),
    });
    seeded.close();

    const old = connect(dbPath);
    old.exec("DROP INDEX idx_completion_receipts_wo");
    old.exec("DROP TABLE completion_receipts");
    old.close();

    // Reopening runs the additive migration: the table appears, everything
    // already in the file survives untouched.
    const reopened = new SqliteStore(dbPath);
    try {
      expect(reopened.getEntity(wo.id)?.title).toBe("pre-existing");
      expect(reopened.listContextReceipts(wo.id)).toHaveLength(1);

      reopened.saveCompletionReceipt({
        id: randomUUID(),
        workOrderId: wo.id,
        summary: "recorded after migration",
        verification: "listed back below",
        commits: [],
        filesTouched: [],
        createdAt: new Date().toISOString(),
      });
      expect(reopened.listCompletionReceipts(wo.id)).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });
});
