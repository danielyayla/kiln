import { describe, expect, it } from "vitest";
import { applySuggestion, SqliteStore, Suggestion, type Entity } from "@kiln/core";
import type { CompleteRequest, ModelProvider, ModelResult } from "../model/index.js";
import { buildDraftPrompt, DraftError, draftSuggestion, EMIT_SUGGESTION_TOOL } from "./draft.js";
import { BLUEPRINT_TEMPLATE, REQUIREMENT_TEMPLATE, templateSectionFromSkills } from "./templates.js";

const TARGET: Entity = {
  id: "req-1",
  type: "requirement",
  title: "Traceable handoff",
  body: "",
  status: null,
  assignee: null,
  createdAt: "2026-07-06T00:00:00.000Z",
  updatedAt: "2026-07-06T00:00:00.000Z",
};

const ARTIFACT: Entity = {
  ...TARGET,
  id: "art-1",
  type: "artifact",
  title: "Kickoff transcript",
  body: "Users keep losing the thread between intent and code.",
};

// A provider that replays scripted tool-call inputs and records every request.
function scriptedProvider(inputs: unknown[]): { provider: ModelProvider; requests: CompleteRequest[] } {
  const requests: CompleteRequest[] = [];
  let call = 0;
  const provider: ModelProvider = {
    async complete(req): Promise<ModelResult> {
      requests.push(req);
      const input = inputs[Math.min(call++, inputs.length - 1)];
      return {
        text: "",
        toolCall: input === undefined ? null : { name: "emit_suggestion", input },
        stopReason: "tool_use",
        model: "scripted",
      };
    },
  };
  return { provider, requests };
}

const VALID_OPS = {
  ops: [
    {
      kind: "insert",
      anchor: "",
      text: "## User story\nAs a builder, I want traceable handoff.\n\n## Acceptance criteria\n- Context arrives in one call",
    },
  ],
};

describe("buildDraftPrompt", () => {
  it("is template-driven: swapping the template changes the required structure", () => {
    const req = buildDraftPrompt({ target: TARGET, artifacts: [], template: REQUIREMENT_TEMPLATE });
    const bp = buildDraftPrompt({ target: TARGET, artifacts: [], template: BLUEPRINT_TEMPLATE });

    // Methodology-shaped structures (docs/authoring-methodology.md).
    expect(req.system).toContain("## Capability");
    expect(req.system).toContain("## Non-goals");
    expect(req.system).toContain("## Success criteria");
    expect(req.system).not.toContain("## Key decisions");

    expect(bp.system).toContain("## Approach");
    expect(bp.system).toContain("## Key decisions");
    expect(bp.system).toContain("## Verification strategy");
    expect(bp.system).not.toContain("## Capability");
  });

  it("includes the current body and every artifact", () => {
    const target = { ...TARGET, body: "existing body text" };
    const { user } = buildDraftPrompt({ target, artifacts: [ARTIFACT], template: REQUIREMENT_TEMPLATE });
    expect(user).toContain("existing body text");
    expect(user).toContain("Kickoff transcript");
    expect(user).toContain("losing the thread");
  });
});

const TEMPLATE_SKILL = {
  title: "Org blueprint style",
  body: `Some preamble.

## Template: requirement

\`\`\`
## Problem
<the problem>

## Solution sketch
<the solution>

## Rollout
<how it ships>
\`\`\`

## Other section
Not part of the template.`,
};

describe("templateSectionFromSkills", () => {
  it("extracts a fenced template verbatim, excluding surrounding prose", () => {
    const section = templateSectionFromSkills([TEMPLATE_SKILL], "requirement");
    expect(section).toContain("## Problem");
    expect(section).toContain("## Rollout");
    expect(section).not.toContain("Other section");
    expect(section).not.toContain("preamble");
    expect(section).not.toContain("```");
  });

  it("an unfenced template runs to the next Template declaration or end of body", () => {
    const skill = {
      title: "Two templates",
      body: "## Template: requirement\n\n## Problem\n<p>\n\n## Template: blueprint\n\n## Design\n<d>",
    };
    const req = templateSectionFromSkills([skill], "requirement");
    expect(req).toContain("## Problem");
    expect(req).not.toContain("## Design");
    expect(templateSectionFromSkills([skill], "blueprint")).toContain("## Design");
  });

  it("returns null when no skill declares a template for the type", () => {
    expect(templateSectionFromSkills([TEMPLATE_SKILL], "blueprint")).toBeNull();
    expect(templateSectionFromSkills([], "requirement")).toBeNull();
  });

  it("first skill in array order wins when several declare the same type", () => {
    const second = {
      title: "Later skill",
      body: "## Template: requirement\n\n## Loser section\nnever used",
    };
    expect(templateSectionFromSkills([TEMPLATE_SKILL, second], "requirement")).toContain("## Problem");
    expect(templateSectionFromSkills([second, TEMPLATE_SKILL], "requirement")).toContain("## Loser section");
  });
});

describe("buildDraftPrompt — authoring skills", () => {
  it("a matching template override replaces the built-in structure verbatim", () => {
    const { system } = buildDraftPrompt({
      target: TARGET,
      artifacts: [],
      template: REQUIREMENT_TEMPLATE,
      skills: [TEMPLATE_SKILL],
    });
    expect(system).toContain("## Problem");
    expect(system).toContain("## Solution sketch");
    expect(system).not.toContain("## Capability");
    // The built-in guidance travels with the built-in structure.
    expect(system).not.toContain("Style guidance:");
  });

  it("skills without a matching template keep the built-in structure and render as a section", () => {
    const styleOnly = { title: "Terse docs", body: "Never exceed 300 words." };
    const { system } = buildDraftPrompt({
      target: TARGET,
      artifacts: [],
      template: REQUIREMENT_TEMPLATE,
      skills: [styleOnly],
    });
    expect(system).toContain("## Capability");
    expect(system).toContain("Authoring skills (house standards — follow these):");
    expect(system).toContain("Never exceed 300 words.");
  });

  it("is byte-identical to the zero-skill baseline when skills are empty or absent", () => {
    const baseline = buildDraftPrompt({ target: TARGET, artifacts: [], template: REQUIREMENT_TEMPLATE });
    const empty = buildDraftPrompt({
      target: TARGET,
      artifacts: [],
      template: REQUIREMENT_TEMPLATE,
      skills: [],
    });
    expect(empty.system).toBe(baseline.system);
    expect(empty.user).toBe(baseline.user);
    expect(baseline.system).not.toContain("Authoring skills");
  });
});

describe("draftSuggestion", () => {
  it("returns a Zod-valid Suggestion from a valid emit call", async () => {
    const { provider, requests } = scriptedProvider([VALID_OPS]);

    const suggestion = await draftSuggestion(provider, {
      target: TARGET,
      artifacts: [ARTIFACT],
      template: REQUIREMENT_TEMPLATE,
    });

    expect(() => Suggestion.parse(suggestion)).not.toThrow();
    expect(suggestion.targetId).toBe("req-1");
    expect(suggestion.source).toBe("draft_agent");
    expect(suggestion.ops).toEqual(VALID_OPS.ops);

    // The model was offered exactly the single emit tool at the reason tier.
    expect(requests).toHaveLength(1);
    expect(requests[0].tools).toEqual([EMIT_SUGGESTION_TOOL]);
    expect(requests[0].tier).toBe("reason");
  });

  it("rejects malformed output and retries with the validation error", async () => {
    const malformed = { ops: [{ kind: "explode", anchor: "x" }] };
    const { provider, requests } = scriptedProvider([malformed, VALID_OPS]);

    const suggestion = await draftSuggestion(provider, {
      target: TARGET,
      artifacts: [],
      template: REQUIREMENT_TEMPLATE,
    });

    expect(suggestion.ops).toEqual(VALID_OPS.ops);
    expect(requests).toHaveLength(2);
    // The retry conversation carries the rejection so the model can correct.
    const retryMessages = requests[1].messages;
    expect(retryMessages.at(-1)?.content).toContain("rejected");
    expect(retryMessages.at(-2)?.content).toContain("explode");
  });

  it("retries when the model makes no tool call at all", async () => {
    const { provider, requests } = scriptedProvider([undefined, VALID_OPS]);

    const suggestion = await draftSuggestion(provider, {
      target: TARGET,
      artifacts: [],
      template: REQUIREMENT_TEMPLATE,
    });
    expect(suggestion.ops).toEqual(VALID_OPS.ops);
    expect(requests).toHaveLength(2);
  });

  it("throws DraftError after exhausting attempts", async () => {
    const { provider, requests } = scriptedProvider([{ ops: [] }]);

    await expect(
      draftSuggestion(provider, { target: TARGET, artifacts: [], template: REQUIREMENT_TEMPLATE }, { maxAttempts: 2 }),
    ).rejects.toThrow(DraftError);
    expect(requests).toHaveLength(2);
  });

  it("drafted ops apply cleanly through the edit engine", async () => {
    const store = new SqliteStore(":memory:");
    try {
      const target = store.createEntity({ type: "requirement", title: "Traceable handoff" });
      const { provider } = scriptedProvider([VALID_OPS]);

      const suggestion = await draftSuggestion(provider, {
        target,
        artifacts: [ARTIFACT],
        template: REQUIREMENT_TEMPLATE,
      });
      store.saveSuggestion(suggestion);

      const { entity, revision } = applySuggestion(store, suggestion.id, [0]);
      expect(entity.body).toContain("## User story");
      expect(entity.body).toContain("## Acceptance criteria");
      expect(store.listRevisions(target.id)).toHaveLength(1);
      expect(revision.body).toBe(entity.body);
    } finally {
      store.close();
    }
  });
});
