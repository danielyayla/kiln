import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assembleWorkOrderContext,
  ConstraintError,
  NotFoundError,
  SqliteStore,
  type Entity,
} from "@kiln/core";
import type { CompleteRequest, ModelProvider, ModelResult } from "../model/index.js";
import {
  acceptCandidate,
  buildExtractPrompt,
  EMIT_WORK_ORDERS_TOOL,
  ExtractError,
  extractWorkOrders,
} from "./extract.js";

function scriptedProvider(inputs: unknown[]): { provider: ModelProvider; requests: CompleteRequest[] } {
  const requests: CompleteRequest[] = [];
  let call = 0;
  const provider: ModelProvider = {
    async complete(req): Promise<ModelResult> {
      requests.push(req);
      const input = inputs[Math.min(call++, inputs.length - 1)];
      return {
        text: "",
        toolCall: input === undefined ? null : { name: "emit_work_orders", input },
        stopReason: "tool_use",
        model: "scripted",
      };
    },
  };
  return { provider, requests };
}

const CANDIDATES = {
  candidates: [
    {
      title: "Build the store layer",
      body: "Implement the Store interface. Done when CRUD tests pass.",
      workType: "feature" as const,
    },
    {
      title: "Wire the MCP bridge",
      body: "Expose the three tools over MCP. Done when a client lists them.",
      workType: "feature" as const,
    },
  ],
};

let store: SqliteStore;
let blueprint: Entity;

beforeEach(() => {
  store = new SqliteStore(":memory:");
  blueprint = store.createEntity({
    type: "blueprint",
    title: "MCP work-order bridge",
    body: "## Approach\nServe ready work orders over MCP.\n\n## Components\n- store\n- bridge",
  });
});

afterEach(() => store.close());

describe("buildExtractPrompt", () => {
  it("demands the methodology work-order shape, including the ready-gate checklist", () => {
    const bp: Entity = {
      id: "bp-1",
      type: "blueprint",
      title: "BP",
      body: "the approach",
      status: null,
      workType: null,
      assignee: null,
      createdAt: "t",
      updatedAt: "t",
    };
    const { system } = buildExtractPrompt(bp);
    expect(system).toContain("## Scope");
    expect(system).toContain("## Out of scope");
    expect(system).toContain("## Acceptance criteria");
    expect(system).toContain('"- [ ]" checklist');
    expect(system).toContain("## Implementation hints");
  });

  it("a skill's work-order template replaces the house shape; other skills render as a section", () => {
    const bp: Entity = {
      id: "bp-1",
      type: "blueprint",
      title: "BP",
      body: "the approach",
      status: null,
      workType: null,
      assignee: null,
      createdAt: "t",
      updatedAt: "t",
    };
    const templateSkill = {
      title: "Org WO shape",
      body: "## Template: work-order\n\n## Task\n<what>\n\n## Done when\n<checks>",
    };
    const { system } = buildExtractPrompt(bp, [templateSkill]);
    expect(system).toContain("## Task");
    expect(system).toContain("## Done when");
    expect(system).not.toContain("house work-order shape");
    expect(system).toContain("Authoring skills (house standards — follow these):");

    // Empty/absent skills leave the prompt byte-identical.
    expect(buildExtractPrompt(bp, []).system).toBe(buildExtractPrompt(bp).system);
    expect(buildExtractPrompt(bp).system).not.toContain("Authoring skills");
  });
});

describe("extractWorkOrders", () => {
  it("returns candidates from a valid emit call, offering only the emit tool", async () => {
    const { provider, requests } = scriptedProvider([CANDIDATES]);

    const candidates = await extractWorkOrders(provider, blueprint);

    expect(candidates).toEqual(CANDIDATES.candidates);
    expect(requests).toHaveLength(1);
    expect(requests[0].tools).toEqual([EMIT_WORK_ORDERS_TOOL]);
    expect(requests[0].tier).toBe("reason");
    expect(requests[0].messages[0].content).toContain(blueprint.body);
  });

  it("rejects malformed output and retries with the validation error", async () => {
    const malformed = { candidates: [{ title: "missing body" }] };
    const { provider, requests } = scriptedProvider([malformed, CANDIDATES]);

    const candidates = await extractWorkOrders(provider, blueprint);

    expect(candidates).toEqual(CANDIDATES.candidates);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.at(-1)?.content).toContain("rejected");
  });

  it("throws ExtractError after exhausting attempts", async () => {
    const { provider, requests } = scriptedProvider([{ candidates: [] }]);

    await expect(extractWorkOrders(provider, blueprint, { maxAttempts: 2 })).rejects.toThrow(ExtractError);
    expect(requests).toHaveLength(2);
  });

  it("refuses to extract from a non-blueprint", async () => {
    const requirement = store.createEntity({ type: "requirement", title: "R" });
    const { provider } = scriptedProvider([CANDIDATES]);

    await expect(extractWorkOrders(provider, requirement)).rejects.toThrow(ConstraintError);
  });
});

describe("acceptCandidate", () => {
  it("creates a draft work_order linked implements → blueprint", () => {
    const workOrder = acceptCandidate(store, blueprint.id, CANDIDATES.candidates[0]);

    expect(workOrder.type).toBe("work_order");
    expect(workOrder.status).toBe("draft");
    expect(workOrder.title).toBe("Build the store layer");

    // The link is walkable in both directions.
    expect(store.linked(workOrder.id, "implements").map((e) => e.id)).toEqual([blueprint.id]);
    expect(store.linkedFrom(blueprint.id, "implements").map((e) => e.id)).toEqual([workOrder.id]);
  });

  it("rejects unknown or non-blueprint targets", () => {
    expect(() => acceptCandidate(store, "missing", CANDIDATES.candidates[0])).toThrow(NotFoundError);
    const artifact = store.createEntity({ type: "artifact", title: "A" });
    expect(() => acceptCandidate(store, artifact.id, CANDIDATES.candidates[0])).toThrow(ConstraintError);
  });
});

describe("work types", () => {
  it("the emit tool schema requires workType from the closed set", () => {
    const item = (EMIT_WORK_ORDERS_TOOL.inputSchema as { properties: { candidates: { items: any } } })
      .properties.candidates.items;
    expect(item.required).toContain("workType");
    expect(item.properties.workType.enum).toEqual(["feature", "bug", "refactor", "perf", "chore"]);
  });

  it("the prompt explains the closed set with the feature default", () => {
    const { system } = buildExtractPrompt(blueprint);
    for (const t of ["feature", "bug", "refactor", "perf", "chore"]) {
      expect(system).toContain(`"${t}"`);
    }
    expect(system).toContain("workType");
  });

  it("returns emitted workTypes and rejects values outside the closed set", async () => {
    const bad = { candidates: [{ title: "Fix crash", body: "b", workType: "urgent" }] };
    const typed = { candidates: [{ title: "Fix crash", body: "b", workType: "bug" }] };
    const { provider, requests } = scriptedProvider([bad, typed]);

    const candidates = await extractWorkOrders(provider, blueprint);

    expect(candidates[0].workType).toBe("bug");
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.at(-1)?.content).toContain("rejected");
  });

  it("acceptCandidate persists the workType on the created work order", () => {
    const wo = acceptCandidate(store, blueprint.id, { title: "Fix crash", body: "b", workType: "bug" });
    expect(store.getEntity(wo.id)?.workType).toBe("bug");
  });

  it("a candidate without a workType lands as an explicit feature", () => {
    const wo = acceptCandidate(store, blueprint.id, { title: "T", body: "b" });
    expect(store.getEntity(wo.id)?.workType).toBe("feature");
  });
});

describe("end-to-end: extract → accept → context assembly", () => {
  it("accepted candidates surface with full context through the graph", async () => {
    // Wire the blueprint into an intent chain first.
    const artifact = store.createEntity({ type: "artifact", title: "Transcript", body: "source" });
    const requirement = store.createEntity({ type: "requirement", title: "Traceable handoff" });
    store.link(blueprint.id, requirement.id, "details");
    store.link(requirement.id, artifact.id, "references");

    const { provider } = scriptedProvider([CANDIDATES]);
    const candidates = await extractWorkOrders(provider, blueprint);

    // Accept both candidates; reject nothing this time.
    const accepted = candidates.map((c) => acceptCandidate(store, blueprint.id, c));
    expect(store.workOrdersByStatus("draft").map((w) => w.id).sort()).toEqual(
      accepted.map((w) => w.id).sort(),
    );

    // Each accepted work order reassembles the entire intent chain.
    for (const workOrder of accepted) {
      const ctx = assembleWorkOrderContext(store, workOrder.id);
      expect(ctx.blueprint?.id).toBe(blueprint.id);
      expect(ctx.requirement?.id).toBe(requirement.id);
      expect(ctx.artifacts.map((a) => a.id)).toEqual([artifact.id]);
    }
  });
});
