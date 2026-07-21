import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompletionReport } from "../domain";
import { ConstraintError, NotFoundError } from "../errors";
import { SqliteStore } from "../store/sqlite-store";
import { recordCompletionReceipt } from "./completion";

let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore(":memory:");
});
afterEach(() => store.close());

const report = {
  summary: "implemented the widget",
  verification: "vitest run — 12 passed; exercised live against the dev sidecar",
};

describe("CompletionReport schema", () => {
  it("rejects an empty summary and a whitespace-only verification", () => {
    expect(() => CompletionReport.parse({ ...report, summary: "" })).toThrow(/summary/);
    expect(() => CompletionReport.parse({ ...report, verification: "   \n\t" })).toThrow(
      /verification/,
    );
  });

  it("defaults commits and filesTouched to empty lists and leaves branch optional", () => {
    const parsed = CompletionReport.parse(report);
    expect(parsed.commits).toEqual([]);
    expect(parsed.filesTouched).toEqual([]);
    expect(parsed.branch).toBeUndefined();
  });

  it("keeps testimony verbatim — no trimming", () => {
    const parsed = CompletionReport.parse({ ...report, summary: "  padded but real  " });
    expect(parsed.summary).toBe("  padded but real  ");
  });
});

describe("recordCompletionReceipt", () => {
  it("persists the receipt and returns it", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "done" });
    const r = recordCompletionReceipt(store, wo.id, {
      ...report,
      commits: ["abc123"],
      branch: "main",
      filesTouched: ["src/widget.ts"],
    });

    expect(r.workOrderId).toBe(wo.id);
    expect(r.commits).toEqual(["abc123"]);
    expect(store.listCompletionReceipts(wo.id)).toEqual([r]);
  });

  it("does not gate on work-order status — policy lives at the MCP boundary", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "draft" });
    expect(recordCompletionReceipt(store, wo.id, report).workOrderId).toBe(wo.id);
  });

  it("throws NotFoundError for a missing id", () => {
    expect(() => recordCompletionReceipt(store, "nope", report)).toThrow(NotFoundError);
  });

  it("throws ConstraintError for a non-work-order target", () => {
    const req = store.createEntity({ type: "requirement", title: "R" });
    expect(() => recordCompletionReceipt(store, req.id, report)).toThrow(ConstraintError);
    expect(() => recordCompletionReceipt(store, req.id, report)).toThrow(/requirement/);
  });

  it("rejects an invalid report before writing anything", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "done" });
    expect(() => recordCompletionReceipt(store, wo.id, { ...report, summary: " " })).toThrow();
    expect(store.listCompletionReceipts(wo.id)).toEqual([]);
  });

  it("is append-only: recording twice yields two receipts", () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "done" });
    const first = recordCompletionReceipt(store, wo.id, report);
    const second = recordCompletionReceipt(store, wo.id, report);

    expect(second.id).not.toBe(first.id);
    expect(store.listCompletionReceipts(wo.id).map((r) => r.id)).toEqual([first.id, second.id]);
  });
});
