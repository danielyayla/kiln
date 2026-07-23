import { describe, expect, it } from "vitest";
import type { CompletionReceipt, Entity, WorkOrderContext } from "@kiln/core";
import type { CompleteRequest, ModelProvider, ModelResult } from "../model/index.js";
import { buildVerifyPrompt, EMIT_VERDICT_TOOL, VerifyError, verifyWorkOrder } from "./verify.js";

const entity = (over: Partial<Entity>): Entity => ({
  id: "wo-1",
  type: "work_order",
  title: "Add the widget",
  body: "## Scope\nBuild the widget.\n\n## Acceptance criteria\n- [ ] widget renders\n- [ ] tests: widget unit tests pass",
  status: "done",
  workType: null,
  criticality: null,
  assignee: null,
  createdAt: "2026-07-23T00:00:00.000Z",
  updatedAt: "2026-07-23T00:00:00.000Z",
  ...over,
});

const context = (over: Partial<WorkOrderContext> = {}): WorkOrderContext => ({
  workOrder: entity({}),
  workType: "feature",
  guidance: "Feature work: implement to the blueprint's design.",
  blueprint: entity({ id: "bp-1", type: "blueprint", title: "Widget BP", body: "The widget approach.", status: null }),
  requirement: entity({ id: "req-1", type: "requirement", title: "Widgets", body: "Users get widgets.", status: null }),
  artifacts: [],
  lineage: [],
  ...over,
});

const receipt = (over: Partial<CompletionReceipt> = {}): CompletionReceipt => ({
  id: "cr-1",
  workOrderId: "wo-1",
  summary: "Built the widget renderer",
  verification: "pnpm test — widget suite 12/12 green",
  commits: ["abc123"],
  branch: "main",
  filesTouched: ["src/widget.ts"],
  createdAt: "2026-07-23T01:00:00.000Z",
  ...over,
});

function scriptedProvider(inputs: unknown[]): { provider: ModelProvider; requests: CompleteRequest[] } {
  const requests: CompleteRequest[] = [];
  let call = 0;
  const provider: ModelProvider = {
    async complete(req): Promise<ModelResult> {
      requests.push(req);
      const input = inputs[Math.min(call++, inputs.length - 1)];
      return {
        text: "",
        toolCall: input === undefined ? null : { name: "emit_verdict", input },
        stopReason: "tool_use",
        model: "scripted",
      };
    },
  };
  return { provider, requests };
}

const verdictEntry = (criterion: string, status: "met" | "unmet" | "undecidable", reason: string) => ({
  criterion,
  status,
  reason,
});

describe("buildVerifyPrompt", () => {
  it("carries the acceptance criteria, the linked pair, and the completion receipts", () => {
    const { system, user } = buildVerifyPrompt(context(), [receipt()]);
    expect(system).toContain("widget renders");
    expect(system).toContain("The widget approach."); // blueprint
    expect(system).toContain("Users get widgets."); // requirement
    expect(system).toContain("widget suite 12/12 green"); // receipt testimony
    expect(system).toContain("Commits: abc123");
    expect(system).toContain("emit_verdict");
    expect(user).toContain("acceptance criteria");
  });

  it("instructs the judge: silence is undecidable, never met; no criteria means empty + undecidable", () => {
    const { system } = buildVerifyPrompt(context(), [receipt()]);
    expect(system).toContain("Silence is undecidable, NEVER met");
    expect(system).toContain("no acceptance criteria, emit an empty criteria list");
  });

  it("renders missing links and zero receipts gracefully", () => {
    const { system } = buildVerifyPrompt(context({ blueprint: null, requirement: null }), []);
    expect(system).not.toContain("Blueprint (design context)");
    expect(system).not.toContain("Requirement (intent context)");
    expect(system).toContain("(none recorded)");
    expect(system).toContain("no completion receipts, every criterion is undecidable");
  });
});

describe("verifyWorkOrder — verdicts through a scripted provider", () => {
  it("returns met verdicts for a receipt addressing all criteria", async () => {
    const emitted = {
      criteria: [
        verdictEntry("widget renders", "met", "receipt names the renderer and cites a green run"),
        verdictEntry("tests: widget unit tests pass", "met", "12/12 green cited verbatim"),
      ],
      overall: "met",
    };
    const { provider, requests } = scriptedProvider([emitted]);

    const verdict = await verifyWorkOrder(provider, context(), [receipt()]);
    expect(verdict).toEqual(emitted);

    expect(requests).toHaveLength(1);
    expect(requests[0].tools).toEqual([EMIT_VERDICT_TOOL]);
    expect(requests[0].tier).toBe("reason");
    // Forced structured output: no toolChoice override (default forces the single tool).
    expect(requests[0].toolChoice).toBeUndefined();
  });

  it("returns unmet and undecidable verdicts unchanged — a receipt silent on a criterion is undecidable, not met", async () => {
    const emitted = {
      criteria: [
        verdictEntry("widget renders", "unmet", "receipt says rendering was deferred"),
        verdictEntry("tests: widget unit tests pass", "undecidable", "receipt is silent on tests"),
      ],
      overall: "unmet",
    };
    const { provider } = scriptedProvider([emitted]);

    const verdict = await verifyWorkOrder(provider, context(), [receipt()]);
    expect(verdict).toEqual(emitted);
  });

  it("accepts the explicit no-acceptance-criteria result: empty criteria, overall undecidable", async () => {
    const noCriteria = context({ workOrder: entity({ body: "## Scope\nJust do it." }) });
    const { provider } = scriptedProvider([{ criteria: [], overall: "undecidable" }]);

    const verdict = await verifyWorkOrder(provider, noCriteria, [receipt()]);
    expect(verdict).toEqual({ criteria: [], overall: "undecidable" });
  });

  it("never writes anywhere — the agent returns data only", async () => {
    const { provider } = scriptedProvider([{ criteria: [], overall: "undecidable" }]);
    const verdict = await verifyWorkOrder(provider, context(), []);
    // Nothing to assert beyond the returned value: the function has no store
    // parameter at all, which is the contract.
    expect(verdict.overall).toBe("undecidable");
  });
});

describe("verifyWorkOrder — invalid output is rejected, retried, surfaced", () => {
  it("retries with the validation error on an unknown status", async () => {
    const malformed = { criteria: [verdictEntry("widget renders", "maybe" as never, "unsure")], overall: "met" };
    const good = { criteria: [verdictEntry("widget renders", "met", "cited")], overall: "met" };
    const { provider, requests } = scriptedProvider([malformed, good]);

    const verdict = await verifyWorkOrder(provider, context(), [receipt()]);
    expect(verdict).toEqual(good);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.at(-1)?.content).toContain("rejected");
  });

  it("rejects a blank reason — verdicts must be grounded", async () => {
    const malformed = { criteria: [verdictEntry("widget renders", "met", "   ")], overall: "met" };
    const good = { criteria: [verdictEntry("widget renders", "met", "cited")], overall: "met" };
    const { provider, requests } = scriptedProvider([malformed, good]);

    await verifyWorkOrder(provider, context(), [receipt()]);
    expect(requests).toHaveLength(2);
  });

  it("retries when the model makes no tool call", async () => {
    const { provider, requests } = scriptedProvider([undefined, { criteria: [], overall: "undecidable" }]);
    await verifyWorkOrder(provider, context(), []);
    expect(requests).toHaveLength(2);
  });

  it("throws VerifyError after exhausting attempts", async () => {
    const { provider, requests } = scriptedProvider([{ bad: true }]);
    await expect(verifyWorkOrder(provider, context(), [], { maxAttempts: 2 })).rejects.toThrow(VerifyError);
    expect(requests).toHaveLength(2);
  });
});
