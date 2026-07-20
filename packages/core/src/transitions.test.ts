import { describe, expect, it } from "vitest";
import { WORK_ORDER_STATUSES, type WorkOrderStatus } from "./domain";
import { allowedNextStatuses, canTransition } from "./transitions";

describe("status transitions", () => {
  it("permits the forward lifecycle", () => {
    expect(canTransition("draft", "ready")).toBe(true);
    expect(canTransition("ready", "in_progress")).toBe(true);
    expect(canTransition("in_progress", "done")).toBe(true);
  });

  it("allows cancelling from any non-cancelled state", () => {
    for (const from of WORK_ORDER_STATUSES) {
      const expected = from !== "cancelled";
      expect(canTransition(from, "cancelled")).toBe(expected);
    }
  });

  it("rejects skipping stages", () => {
    expect(canTransition("draft", "in_progress")).toBe(false);
    expect(canTransition("ready", "done")).toBe(false);
    expect(canTransition("draft", "done")).toBe(false);
  });

  it("rejects backward moves", () => {
    expect(canTransition("in_progress", "ready")).toBe(false);
    expect(canTransition("ready", "draft")).toBe(false);
    expect(canTransition("done", "in_progress")).toBe(false);
  });

  it("treats no-ops as non-transitions", () => {
    for (const s of WORK_ORDER_STATUSES) {
      expect(canTransition(s, s)).toBe(false);
    }
  });

  it("treats done and cancelled as terminal (only done→cancelled remains)", () => {
    expect(allowedNextStatuses("done")).toEqual(["cancelled"]);
    expect(allowedNextStatuses("cancelled")).toEqual([]);
  });

  it("never lists the current status as a next state", () => {
    for (const from of WORK_ORDER_STATUSES as readonly WorkOrderStatus[]) {
      expect(allowedNextStatuses(from)).not.toContain(from);
    }
  });
});
