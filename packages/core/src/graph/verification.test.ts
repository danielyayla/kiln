import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VerificationVerdict, type CriterionVerdict } from "../domain";
import { ConstraintError, NotFoundError } from "../errors";
import { SqliteStore } from "../store/sqlite-store";
import { recordVerificationReceipt, verificationAttention, verificationStatus } from "./verification";

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

describe("verificationStatus", () => {
  it("classifies no receipts as unverified", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "done" });
    expect(verificationStatus(store, wo.id)).toBe("unverified");
  });

  it("classifies a clean latest verdict — overall met, every criterion met — as verified", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "done" });
    recordVerificationReceipt(store, wo.id, {
      criteria: [criterion(), criterion({ criterion: "typecheck clean" })],
      overall: "met",
    });
    expect(verificationStatus(store, wo.id)).toBe("verified");
  });

  it("classifies any unmet criterion as verified_with_failures", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "done" });
    recordVerificationReceipt(store, wo.id, {
      criteria: [criterion(), criterion({ criterion: "live verified", status: "unmet", reason: "no evidence" })],
      overall: "met",
    });
    expect(verificationStatus(store, wo.id)).toBe("verified_with_failures");
  });

  it("classifies an undecidable criterion or a non-met overall as verified_with_failures", () => {
    const undecidable = store.createEntity({ type: "work_order", title: "W1", status: "done" });
    recordVerificationReceipt(store, undecidable.id, {
      criteria: [criterion({ status: "undecidable", reason: "receipt is silent" })],
      overall: "met",
    });
    expect(verificationStatus(store, undecidable.id)).toBe("verified_with_failures");

    const overall = store.createEntity({ type: "work_order", title: "W2", status: "done" });
    recordVerificationReceipt(store, overall.id, { criteria: [], overall: "undecidable" });
    expect(verificationStatus(store, overall.id)).toBe("verified_with_failures");
  });

  it("judges only the LATEST receipt — re-verification supersedes for display", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "done" });
    recordVerificationReceipt(store, wo.id, {
      criteria: [criterion({ status: "unmet", reason: "gap" })],
      overall: "unmet",
    });
    expect(verificationStatus(store, wo.id)).toBe("verified_with_failures");

    recordVerificationReceipt(store, wo.id, { criteria: [criterion()], overall: "met" });
    expect(verificationStatus(store, wo.id)).toBe("verified");
  });
});

describe("verificationAttention", () => {
  const done = (title: string, criticality?: "routine" | "important" | "critical") =>
    store.createEntity({ type: "work_order", title, status: "done", ...(criticality ? { criticality } : {}) });

  it("lists critical done-unverified orders and excludes routine ones", () => {
    const critical = done("needs eyes", "critical");
    done("quiet by design", "routine");
    done("unset is routine"); // no criticality — effective routine, also quiet

    const entries = verificationAttention(store);
    expect(entries).toEqual([
      { id: critical.id, title: "needs eyes", criticality: "critical", verification: "unverified" },
    ]);
  });

  it("includes verified-with-failures and drops cleanly verified orders", () => {
    const failed = done("failed verify", "critical");
    recordVerificationReceipt(store, failed.id, {
      criteria: [criterion({ status: "unmet", reason: "gap" })],
      overall: "unmet",
    });
    const clean = done("clean verify", "critical");
    recordVerificationReceipt(store, clean.id, { criteria: [criterion()], overall: "met" });

    const entries = verificationAttention(store);
    expect(entries.map((e) => e.id)).toEqual([failed.id]);
    expect(entries[0].verification).toBe("verified_with_failures");
  });

  it("only surfaces done orders — the signal is scoped to completed work", () => {
    store.createEntity({ type: "work_order", title: "in flight", status: "in_progress", criticality: "critical" });
    store.createEntity({ type: "work_order", title: "still ready", status: "ready", criticality: "critical" });
    expect(verificationAttention(store)).toEqual([]);
  });

  it("weights by criticality: critical before important, then title", () => {
    done("b important", "important");
    done("a critical", "critical");
    done("c critical", "critical");

    expect(verificationAttention(store).map((e) => e.title)).toEqual([
      "a critical",
      "c critical",
      "b important",
    ]);
  });
});
