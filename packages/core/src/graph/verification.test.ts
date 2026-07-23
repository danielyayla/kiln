import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VerificationVerdict, type CriterionVerdict } from "../domain";
import { ConstraintError, NotFoundError } from "../errors";
import { SqliteStore } from "../store/sqlite-store";
import { recordVerificationReceipt } from "./verification";

let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore(":memory:");
});
afterEach(() => store.close());

const criterion = (over: Partial<CriterionVerdict> = {}): CriterionVerdict => ({
  criterion: "tests pass",
  status: "met",
  reason: "receipt cites a green run",
  ...over,
});

describe("VerificationVerdict schema", () => {
  it("accepts an empty criteria list — the overall verdict stands alone", () => {
    const v = VerificationVerdict.parse({ criteria: [], overall: "undecidable" });
    expect(v.criteria).toEqual([]);
    expect(v.overall).toBe("undecidable");
  });

  it("rejects an unknown status, overall or per-criterion", () => {
    expect(() =>
      VerificationVerdict.parse({ criteria: [], overall: "passed" }),
    ).toThrow();
    expect(() =>
      VerificationVerdict.parse({
        criteria: [criterion({ status: "maybe" as any })],
        overall: "met",
      }),
    ).toThrow();
  });

  it("rejects a blank criterion and a whitespace-only reason", () => {
    expect(() =>
      VerificationVerdict.parse({ criteria: [criterion({ criterion: "" })], overall: "met" }),
    ).toThrow();
    expect(() =>
      VerificationVerdict.parse({ criteria: [criterion({ reason: "   " })], overall: "met" }),
    ).toThrow();
  });

  it("rejects a missing criteria list — undecidable is expressed, never implied", () => {
    expect(() => VerificationVerdict.parse({ overall: "met" })).toThrow();
  });
});

describe("recordVerificationReceipt", () => {
  it("persists the receipt and returns it", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "done" });
    const r = recordVerificationReceipt(store, wo.id, {
      criteria: [criterion(), criterion({ criterion: "live verified", status: "unmet", reason: "no live evidence" })],
      overall: "unmet",
    });
    expect(r.workOrderId).toBe(wo.id);
    expect(r.id).toBeTruthy();
    expect(r.createdAt).toBeTruthy();
    expect(store.listVerificationReceipts(wo.id)).toEqual([r]);
  });

  it("does not gate on work-order status — when verification runs is caller policy", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "draft" });
    const r = recordVerificationReceipt(store, wo.id, { criteria: [], overall: "undecidable" });
    expect(store.listVerificationReceipts(wo.id)).toEqual([r]);
  });

  it("throws NotFoundError for a missing id", () => {
    expect(() =>
      recordVerificationReceipt(store, "missing", { criteria: [], overall: "met" }),
    ).toThrow(NotFoundError);
  });

  it("throws ConstraintError for a non-work-order target", () => {
    const req = store.createEntity({ type: "requirement", title: "R" });
    expect(() =>
      recordVerificationReceipt(store, req.id, { criteria: [], overall: "met" }),
    ).toThrow(ConstraintError);
  });

  it("rejects an invalid verdict before writing anything", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "done" });
    expect(() =>
      recordVerificationReceipt(store, wo.id, { criteria: [], overall: "nope" as any }),
    ).toThrow();
    expect(store.listVerificationReceipts(wo.id)).toEqual([]);
  });

  it("is append-only: re-verifying yields two receipts, earlier verdicts readable", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "done" });
    recordVerificationReceipt(store, wo.id, { criteria: [criterion({ status: "unmet", reason: "gap" })], overall: "unmet" });
    recordVerificationReceipt(store, wo.id, { criteria: [criterion()], overall: "met" });
    expect(store.listVerificationReceipts(wo.id).map((r) => r.overall)).toEqual(["unmet", "met"]);
  });
});
