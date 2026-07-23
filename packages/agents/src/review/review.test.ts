import { describe, expect, it } from "vitest";
import { applySuggestion, SqliteStore, Suggestion, type Entity } from "@kiln/core";
import type { CompleteRequest, ModelProvider, ModelResult } from "../model/index.js";
import type { RefineContext } from "../refine/index.js";
import {
  buildReviewPrompt,
  EMIT_REVIEW_TOOL,
  ReviewError,
  reviewDocument,
  type Finding,
} from "./review.js";

const DOC: Entity = {
  id: "req-1",
  type: "requirement",
  title: "Traceable handoff",
  body: "## User story\nAs a builder, I want traceable handoff soon.\n\n## Acceptance criteria\n- Context arrives quickly",
  status: null,
  workType: null,
  criticality: null,
  assignee: null,
  createdAt: "2026-07-08T00:00:00.000Z",
  updatedAt: "2026-07-08T00:00:00.000Z",
};

const BLUEPRINT: Entity = {
  ...DOC,
  id: "bp-1",
  type: "blueprint",
  title: "MCP bridge",
  body: "Also ships a web dashboard.",
};

const CONTEXT: RefineContext = {
  document: DOC,
  requirement: null,
  blueprints: [BLUEPRINT],
  parents: [],
  children: [],
  artifacts: [],
  inheritedArtifacts: [],
  inheritedBlueprints: [],
};

function scriptedProvider(inputs: unknown[]): { provider: ModelProvider; requests: CompleteRequest[] } {
  const requests: CompleteRequest[] = [];
  let call = 0;
  const provider: ModelProvider = {
    async complete(req): Promise<ModelResult> {
      requests.push(req);
      const input = inputs[Math.min(call++, inputs.length - 1)];
      return {
        text: "",
        toolCall: input === undefined ? null : { name: "emit_review", input },
        stopReason: "tool_use",
        model: "scripted",
      };
    },
  };
  return { provider, requests };
}

const finding = (kind: Finding["kind"], quote = "quickly"): Finding => ({
  severity: "major",
  kind,
  note: `a ${kind} problem`,
  quote,
});

describe("buildReviewPrompt", () => {
  it("carries the document, the linked pair, and all four finding kinds", () => {
    const { system, user } = buildReviewPrompt(CONTEXT);
    expect(system).toContain("traceable handoff soon");
    expect(system).toContain("web dashboard"); // the paired blueprint — drift is findable
    for (const kind of ["ambiguity", "gap", "conflict", "duplication"]) {
      expect(system).toContain(kind);
    }
    expect(system).toContain("emit_review");
    expect(user).toContain("requirement");
  });

  it("injects authoring skills ahead of the assembled context; empty is byte-identical", () => {
    const { system } = buildReviewPrompt(CONTEXT, [
      { title: "Terse blueprints", body: "Blueprints never exceed 300 words." },
    ]);
    const heading = "Authoring skills (house standards — follow these):";
    expect(system).toContain(heading);
    expect(system.indexOf(heading)).toBeLessThan(system.indexOf("Linked context"));
    expect(buildReviewPrompt(CONTEXT, []).system).toBe(buildReviewPrompt(CONTEXT).system);
  });
});

describe("reviewDocument — skills option", () => {
  it("passes skills through to the system prompt", async () => {
    const { provider, requests } = scriptedProvider([{ findings: [] }]);
    await reviewDocument(provider, CONTEXT, {
      skills: [{ title: "Terse blueprints", body: "Blueprints never exceed 300 words." }],
    });
    expect(requests[0].system).toContain("Authoring skills (house standards — follow these):");
    expect(requests[0].system).toContain("Terse blueprints");
  });
});

describe("reviewDocument — findings per kind", () => {
  for (const kind of ["ambiguity", "gap", "conflict", "duplication"] as const) {
    it(`returns a validated ${kind} finding`, async () => {
      const { provider, requests } = scriptedProvider([{ findings: [finding(kind)] }]);

      const result = await reviewDocument(provider, CONTEXT);
      expect(result.findings).toEqual([finding(kind)]);
      expect(result.suggestion).toBeNull();

      expect(requests).toHaveLength(1);
      expect(requests[0].tools).toEqual([EMIT_REVIEW_TOOL]);
      expect(requests[0].tier).toBe("reason");
      // Forced structured output: no toolChoice override (default forces the single tool).
      expect(requests[0].toolChoice).toBeUndefined();
    });
  }

  it("accepts an empty findings list — a clean document is a valid result", async () => {
    const { provider } = scriptedProvider([{ findings: [] }]);
    const result = await reviewDocument(provider, CONTEXT);
    expect(result.findings).toEqual([]);
    expect(result.suggestion).toBeNull();
  });

  it("allows an empty quote for document-wide findings", async () => {
    const { provider } = scriptedProvider([{ findings: [finding("gap", "")] }]);
    const result = await reviewDocument(provider, CONTEXT);
    expect(result.findings[0].quote).toBe("");
  });
});

describe("reviewDocument — optional fix ops", () => {
  const OPS = [{ kind: "replace", anchor: "- Context arrives quickly", text: "- Context arrives in a single MCP call" }];

  it("returns a Zod-valid review_agent Suggestion alongside the findings", async () => {
    const { provider } = scriptedProvider([{ findings: [finding("ambiguity")], ops: OPS }]);

    const result = await reviewDocument(provider, CONTEXT);
    expect(result.findings).toHaveLength(1);
    expect(result.suggestion).not.toBeNull();
    expect(() => Suggestion.parse(result.suggestion)).not.toThrow();
    expect(result.suggestion!.source).toBe("review_agent");
    expect(result.suggestion!.targetId).toBe("req-1");
    expect(result.suggestion!.ops).toEqual(OPS);
  });

  it("review ops apply cleanly through the edit engine once saved", async () => {
    const store = new SqliteStore(":memory:");
    try {
      const doc = store.createEntity({ type: "requirement", title: "T", body: DOC.body });
      const context: RefineContext = { ...CONTEXT, document: doc };
      const { provider } = scriptedProvider([{ findings: [finding("ambiguity")], ops: OPS }]);

      const { suggestion } = await reviewDocument(provider, context);
      store.saveSuggestion(suggestion!);
      const { entity } = applySuggestion(store, suggestion!.id, [0]);
      expect(entity.body).toContain("single MCP call");
    } finally {
      store.close();
    }
  });
});

describe("reviewDocument — invalid output is rejected, retried, surfaced", () => {
  it("retries with the validation error on malformed findings", async () => {
    const malformed = { findings: [{ severity: "catastrophic", kind: "vibes", note: "", quote: "" }] };
    const { provider, requests } = scriptedProvider([malformed, { findings: [finding("gap")] }]);

    const result = await reviewDocument(provider, CONTEXT);
    expect(result.findings).toEqual([finding("gap")]);
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.at(-1)?.content).toContain("rejected");
  });

  it("retries when the model makes no tool call", async () => {
    const { provider, requests } = scriptedProvider([undefined, { findings: [] }]);
    await reviewDocument(provider, CONTEXT);
    expect(requests).toHaveLength(2);
  });

  it("throws ReviewError after exhausting attempts", async () => {
    const { provider, requests } = scriptedProvider([{ findings: [{ bad: true }] }]);
    await expect(reviewDocument(provider, CONTEXT, { maxAttempts: 2 })).rejects.toThrow(ReviewError);
    expect(requests).toHaveLength(2);
  });
});
