import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connect } from "../db/connect";
import { NotFoundError } from "../errors";
import { SqliteStore } from "./sqlite-store";
import type { VerificationReceipt } from "../domain";

let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore(":memory:");
});
afterEach(() => store.close());

function receipt(
  workOrderId: string,
  overall: VerificationReceipt["overall"],
  extra: Partial<VerificationReceipt> = {},
): VerificationReceipt {
  return {
    id: randomUUID(),
    workOrderId,
    criteria: [
      { criterion: "tests pass", status: "met", reason: "receipt cites green run" },
    ],
    overall,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}

describe("verification receipts", () => {
  it("saves a receipt and reads it back, criteria round-tripping through JSON", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "done" });
    const r = receipt(wo.id, "unmet", {
      criteria: [
        { criterion: "tests pass", status: "met", reason: "receipt cites green run" },
        { criterion: "live verified", status: "unmet", reason: "no live evidence in receipt" },
        { criterion: "docs updated", status: "undecidable", reason: "receipt is silent on docs" },
      ],
    });
    store.saveVerificationReceipt(r);

    const list = store.listVerificationReceipts(wo.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual(r);
  });

  it("accepts an empty criteria list — an order without an acceptance list still gets a verdict", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "done" });
    store.saveVerificationReceipt(receipt(wo.id, "undecidable", { criteria: [] }));

    const [r] = store.listVerificationReceipts(wo.id);
    expect(r.criteria).toEqual([]);
    expect(r.overall).toBe("undecidable");
  });

  it("rejects an unknown verdict status before writing anything", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "done" });
    expect(() =>
      store.saveVerificationReceipt(receipt(wo.id, "passed" as any)),
    ).toThrow();
    expect(() =>
      store.saveVerificationReceipt(
        receipt(wo.id, "met", {
          criteria: [{ criterion: "c", status: "maybe" as any, reason: "r" }],
        }),
      ),
    ).toThrow();
    expect(store.listVerificationReceipts(wo.id)).toEqual([]);
  });

  it("lists receipts in insertion order (append-only, never deduped)", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "done" });
    store.saveVerificationReceipt(receipt(wo.id, "unmet"));
    store.saveVerificationReceipt(receipt(wo.id, "undecidable"));
    store.saveVerificationReceipt(receipt(wo.id, "met"));

    // Ordered oldest→newest even when created_at ties within a millisecond
    // (rowid is the true insertion order) — earlier verdicts stay readable.
    expect(store.listVerificationReceipts(wo.id).map((r) => r.overall)).toEqual([
      "unmet",
      "undecidable",
      "met",
    ]);
  });

  it("exposes no update or delete path — receipts are immutable", () => {
    expect((store as any).updateVerificationReceipt).toBeUndefined();
    expect((store as any).deleteVerificationReceipt).toBeUndefined();
  });

  it("scopes receipts to their work order", () => {
    const a = store.createEntity({ type: "work_order", title: "A", status: "done" });
    const b = store.createEntity({ type: "work_order", title: "B", status: "done" });
    store.saveVerificationReceipt(receipt(a.id, "met"));

    expect(store.listVerificationReceipts(a.id)).toHaveLength(1);
    expect(store.listVerificationReceipts(b.id)).toEqual([]);
  });

  it("refuses a receipt for an unknown work order", () => {
    expect(() => store.saveVerificationReceipt(receipt("does-not-exist", "met"))).toThrow(
      NotFoundError,
    );
  });

  it("cascades receipts when the work order is deleted", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "done" });
    store.saveVerificationReceipt(receipt(wo.id, "met"));
    store.deleteEntity(wo.id);
    expect(store.listVerificationReceipts(wo.id)).toEqual([]);
  });
});

describe("verification_receipts migration", () => {
  const scratch = join(tmpdir(), `kiln-verification-migration-${process.pid}`);
  const dbPath = join(scratch, "kiln.db");

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("adds the table to an existing database without touching existing tables or data", () => {
    // An "older" database: full schema minus verification_receipts, with data.
    mkdirSync(scratch, { recursive: true });
    const seeded = new SqliteStore(dbPath);
    const wo = seeded.createEntity({ type: "work_order", title: "pre-existing", status: "done" });
    seeded.saveCompletionReceipt({
      id: randomUUID(),
      workOrderId: wo.id,
      summary: "kept across migration",
      verification: "listed back below",
      commits: [],
      filesTouched: [],
      createdAt: new Date().toISOString(),
    });
    seeded.close();

    const old = connect(dbPath);
    old.exec("DROP INDEX idx_verification_receipts_wo");
    old.exec("DROP TABLE verification_receipts");
    old.close();

    // Reopening runs the additive migration: the table appears, everything
    // already in the file survives untouched.
    const reopened = new SqliteStore(dbPath);
    try {
      expect(reopened.getEntity(wo.id)?.title).toBe("pre-existing");
      expect(reopened.listCompletionReceipts(wo.id)).toHaveLength(1);

      reopened.saveVerificationReceipt(receipt(wo.id, "met"));
      expect(reopened.listVerificationReceipts(wo.id)).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });
});
