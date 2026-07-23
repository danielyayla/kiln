import { describe, expect, it } from "vitest";
import type { ContextHealth, Entity, EntityType, WorkOrderContext } from "@kiln/core";
import {
  summarizeXRayContext,
  type ContextReceiptWithContext,
} from "./xray-context";

function entity(type: EntityType, title: string, id = title): Entity {
  return {
    id,
    type,
    title,
    body: `${title} body`,
    status: type === "work_order" ? "ready" : null,
    workType: null,
    criticality: null,
    assignee: null,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
}

const workOrder = entity("work_order", "Build context summary", "wo");
const blueprint = entity("blueprint", "Context summary design", "bp");
const requirement = entity("requirement", "Explain the handoff", "req");
const directArtifact = entity("artifact", "Feature brief", "direct");
const ancestor = entity("requirement", "Project intent", "ancestor");
const inheritedArtifact = entity("artifact", "Kickoff transcript", "inherited");

function context(overrides: Partial<WorkOrderContext> = {}): WorkOrderContext {
  return {
    workOrder,
    workType: "feature",
    guidance: "Feature work: implement to the blueprint.",
    blueprint,
    requirement,
    artifacts: [directArtifact],
    lineage: [{ requirement: ancestor, artifacts: [inheritedArtifact] }],
    ...overrides,
  };
}

function health(checks: ContextHealth["checks"] = []): ContextHealth {
  return { size: { chars: 1600, estTokens: 400 }, checks };
}

function receipt(id: string, receiptContext: WorkOrderContext): ContextReceiptWithContext {
  return {
    id,
    workOrderId: workOrder.id,
    context: receiptContext,
    hash: `${id}-hash`,
    createdAt: "2026-07-10T00:00:00.000Z",
  };
}

describe("summarizeXRayContext", () => {
  it("builds the chain and preserves direct and nearest-first inherited context", () => {
    const summary = summarizeXRayContext(context(), health(), []);

    expect(summary.chain.map((item) => [item.type, item.title])).toEqual([
      ["requirement", requirement.title],
      ["blueprint", blueprint.title],
      ["work_order", workOrder.title],
    ]);
    expect(summary.directArtifacts).toEqual([directArtifact]);
    expect(summary.inherited).toEqual([{ requirement: ancestor, artifacts: [inheritedArtifact] }]);
    expect(summary.counts).toEqual({ direct: 1, inherited: 1 });
    expect(summary.estTokens).toBe(400);
  });

  it("preserves explicit missing requirement and blueprint states", () => {
    const summary = summarizeXRayContext(
      context({ blueprint: null, requirement: null, artifacts: [], lineage: [] }),
      health(),
      [],
    );

    expect(summary.chain.slice(0, 2).map((item) => ({ title: item.title, entity: item.entity }))).toEqual([
      { title: "Missing requirement", entity: null },
      { title: "Missing blueprint", entity: null },
    ]);
    expect(summary.counts).toEqual({ direct: 0, inherited: 0 });
  });

  it("returns the worst health severity and ready when there are no checks", () => {
    expect(summarizeXRayContext(context(), health(), []).severity).toBe("ready");
    expect(
      summarizeXRayContext(
        context(),
        health([
          { level: "info", code: "info", message: "Info" },
          { level: "error", code: "error", message: "Error" },
          { level: "warn", code: "warn", message: "Warning" },
        ]),
        [],
      ).severity,
    ).toBe("error");
  });

  it("treats reordered object keys as the same handed-off context", () => {
    const current = context();
    const reordered = {
      lineage: current.lineage,
      artifacts: current.artifacts,
      guidance: current.guidance,
      workType: current.workType,
      requirement: current.requirement,
      blueprint: current.blueprint,
      workOrder: current.workOrder,
    } as WorkOrderContext;

    expect(summarizeXRayContext(current, health(), [receipt("r1", reordered)]).handoff).toBe("current");
  });

  it("uses the newest receipt to detect changed context", () => {
    const current = context();
    const changed = context({ workOrder: { ...workOrder, body: "changed body" } });

    expect(
      summarizeXRayContext(current, health(), [receipt("old", current), receipt("latest", changed)]).handoff,
    ).toBe("changed");
  });

  it("reports when the work order has never been handed off", () => {
    expect(summarizeXRayContext(context(), health(), []).handoff).toBe("never");
  });
});
