import { describe, expect, it } from "vitest";
import { flattenQueue, nextProposal, queuePosition, type QueueGroup } from "./proposal-queue";

const item = (entityId: string) => ({
  entityId,
  entityType: "requirement",
  entityTitle: entityId,
  suggestionId: `s-${entityId}`,
  source: "extract_agent",
  opCount: 1,
});

const groups: QueueGroup[] = [
  { title: "F1", items: [item("r1"), item("b1")] },
  { title: "F2", items: [item("r2"), item("b2")] },
];

describe("proposal queue walk", () => {
  it("flattens groups in order", () => {
    expect(flattenQueue(groups).map((i) => i.entityId)).toEqual(["r1", "b1", "r2", "b2"]);
  });

  it("reports the 1-based position of a queued document, null otherwise", () => {
    const flat = flattenQueue(groups);
    expect(queuePosition(flat, "r1")).toBe(1);
    expect(queuePosition(flat, "b2")).toBe(4);
    expect(queuePosition(flat, "elsewhere")).toBeNull();
  });

  it("advances to the item after the current one", () => {
    const flat = flattenQueue(groups);
    expect(nextProposal(flat, "r1")?.entityId).toBe("b1");
    expect(nextProposal(flat, "b1")?.entityId).toBe("r2");
    expect(nextProposal(flat, "b2")).toBeNull();
  });

  it("falls back to the first remaining item once the current document is resolved", () => {
    // r1's proposal was applied — it left the queue; Next from r1 goes to b1.
    const remaining = flattenQueue([{ title: "F1", items: [item("b1")] }, groups[1]]);
    expect(nextProposal(remaining, "r1")?.entityId).toBe("b1");
    expect(nextProposal([], "r1")).toBeNull();
  });
});
