import { describe, expect, it } from "vitest";
import { applySuggestion, SqliteStore, Suggestion, type Entity } from "@kiln/core";
import type { CompleteRequest, Message, ModelProvider, ModelResult } from "../model/index.js";
import { EMIT_SUGGESTION_TOOL } from "../draft/index.js";
import {
  assembleRefineContext,
  buildRefineSystemPrompt,
  RefineError,
  refineTurn,
  type RefineContext,
} from "./refine.js";

const DOC: Entity = {
  id: "req-1",
  type: "requirement",
  title: "Traceable handoff",
  body: "## User story\nAs a builder, I want traceable handoff.\n\n## Acceptance criteria\n- Context arrives in one call",
  status: null,
  assignee: null,
  createdAt: "2026-07-08T00:00:00.000Z",
  updatedAt: "2026-07-08T00:00:00.000Z",
};

const ARTIFACT: Entity = {
  ...DOC,
  id: "art-1",
  type: "artifact",
  title: "Kickoff transcript",
  body: "Users keep losing the thread between intent and code.",
};

const CONTEXT: RefineContext = {
  document: DOC,
  requirement: null,
  blueprints: [],
  parents: [],
  children: [],
  artifacts: [ARTIFACT],
  inheritedArtifacts: [],
  inheritedBlueprints: [],
};

// A reply the scripted provider should return for one turn: prose (`text`)
// and/or an emit_suggestion tool call carrying `input`.
type Reply = { text?: string; input?: unknown };

// Replays scripted replies and records every request, so tests can assert both
// the model's answer AND the conversation the agent assembled.
function scriptedProvider(replies: Reply[]): { provider: ModelProvider; requests: CompleteRequest[] } {
  const requests: CompleteRequest[] = [];
  let call = 0;
  const provider: ModelProvider = {
    async complete(req): Promise<ModelResult> {
      requests.push(req);
      const reply = replies[Math.min(call++, replies.length - 1)];
      return {
        text: reply.text ?? "",
        toolCall: reply.input === undefined ? null : { name: "emit_suggestion", input: reply.input },
        stopReason: reply.input === undefined ? "end_turn" : "tool_use",
        model: "scripted",
      };
    },
  };
  return { provider, requests };
}

const VALID_OPS = {
  ops: [{ kind: "replace", anchor: "- Context arrives in one call", text: "- The full context arrives in a single MCP call" }],
};

describe("buildRefineSystemPrompt", () => {
  it("carries the document body and every linked-context section", () => {
    const parent: Entity = { ...DOC, id: "req-0", title: "Root intent", body: "Ship the SDLC spine." };
    const child: Entity = { ...DOC, id: "req-2", title: "Sub feature", body: "A narrower slice." };
    const system = buildRefineSystemPrompt({
      ...CONTEXT,
      parents: [parent],
      children: [child],
    });

    expect(system).toContain("refining one requirement");
    expect(system).toContain("As a builder, I want traceable handoff.");
    expect(system).toContain("Kickoff transcript");
    expect(system).toContain("losing the thread");
    expect(system).toContain("Root intent");
    expect(system).toContain("Sub feature");
    // The read-only guard and the "answer or emit" contract must be present.
    expect(system).toContain("never edit it");
    expect(system).toContain("emit_suggestion");
  });

  it("degrades to a no-context note when nothing is linked", () => {
    const system = buildRefineSystemPrompt({ ...CONTEXT, artifacts: [] });
    expect(system).toContain("(no linked context)");
  });

  it("carries the house authoring-standards instruction (review inherits it)", () => {
    const system = buildRefineSystemPrompt(CONTEXT);
    expect(system).toContain("House authoring standards");
    expect(system).toContain("Non-goals");
    // Standards documents found in context are the house style, not a rival convention.
    expect(system).toContain("treat it as the house style");
  });

  it("renders authoring skills ahead of the assembled context", () => {
    const system = buildRefineSystemPrompt(CONTEXT, [
      { title: "Terse blueprints", body: "Blueprints never exceed 300 words." },
      { title: "Terminology", body: 'Say "work order", never "ticket".' },
    ]);
    const heading = "Authoring skills (house standards — follow these):";
    expect(system).toContain(heading);
    expect(system).toContain("## Terse blueprints\nBlueprints never exceed 300 words.");
    expect(system).toContain('## Terminology\nSay "work order", never "ticket".');
    // Skills sit at system-prompt strength, ahead of the linked context.
    expect(system.indexOf(heading)).toBeLessThan(system.indexOf("Linked context"));
    // The hardcoded fallback stays present alongside skills.
    expect(system).toContain("House authoring standards");
  });

  it("is byte-identical to the zero-skill baseline when skills are empty or absent", () => {
    const baseline = buildRefineSystemPrompt(CONTEXT);
    expect(buildRefineSystemPrompt(CONTEXT, [])).toBe(baseline);
    expect(baseline).not.toContain("Authoring skills (house standards — follow these):");
  });
});

describe("refineTurn — pure Q&A (a)", () => {
  it("returns prose with no suggestion and offers the emit tool at reason tier", async () => {
    const { provider, requests } = scriptedProvider([
      { text: "Acceptance criterion 1 (Kickoff transcript) says context must arrive in one call." },
    ]);

    const reply = await refineTurn(provider, CONTEXT, [
      { role: "user", content: "What does this doc require about context delivery?" },
    ]);

    expect(reply.suggestion).toBeNull();
    expect(reply.text).toContain("one call");
    expect(reply.assistantMessage).toEqual({ role: "assistant", content: reply.text });

    expect(requests).toHaveLength(1);
    expect(requests[0].tools).toEqual([EMIT_SUGGESTION_TOOL]);
    expect(requests[0].toolChoice).toBe("auto");
    expect(requests[0].tier).toBe("reason");
  });

  it("injects authoring skills into the system prompt when provided via options", async () => {
    const { provider, requests } = scriptedProvider([{ text: "ok" }]);
    await refineTurn(
      provider,
      CONTEXT,
      [{ role: "user", content: "hi" }],
      { skills: [{ title: "Terse blueprints", body: "Blueprints never exceed 300 words." }] },
    );
    expect(requests[0].system).toContain("Authoring skills (house standards — follow these):");
    expect(requests[0].system).toContain("Terse blueprints");
  });

  it("sends the zero-skill system prompt when no skills are passed", async () => {
    const { provider, requests } = scriptedProvider([{ text: "ok" }]);
    await refineTurn(provider, CONTEXT, [{ role: "user", content: "hi" }]);
    expect(requests[0].system).toBe(buildRefineSystemPrompt(CONTEXT));
  });
});

describe("refineTurn — ops-emitting turn (b)", () => {
  it("returns exactly one Zod-valid Suggestion sourced to the refine agent", async () => {
    const { provider } = scriptedProvider([{ text: "Tightened it:", input: VALID_OPS }]);

    const reply = await refineTurn(provider, CONTEXT, [
      { role: "user", content: "Tighten the acceptance criterion." },
    ]);

    expect(reply.suggestion).not.toBeNull();
    expect(() => Suggestion.parse(reply.suggestion)).not.toThrow();
    expect(reply.suggestion!.targetId).toBe("req-1");
    expect(reply.suggestion!.source).toBe("refine_agent");
    expect(reply.suggestion!.ops).toEqual(VALID_OPS.ops);
    expect(reply.text).toBe("Tightened it:");
  });

  it("summarises a tool-only turn so the transcript stays non-empty", async () => {
    const { provider } = scriptedProvider([{ input: VALID_OPS }]);
    const reply = await refineTurn(provider, CONTEXT, [{ role: "user", content: "Fix it." }]);
    expect(reply.text).toBe("");
    expect(reply.assistantMessage.content).toContain("proposed a suggestion with 1 edit op");
  });

  it("files exactly one suggestion that applies cleanly through the edit engine", async () => {
    const store = new SqliteStore(":memory:");
    try {
      const doc = store.createEntity({ type: "requirement", title: "Traceable handoff", body: DOC.body });
      const context: RefineContext = { ...CONTEXT, document: doc };
      const { provider } = scriptedProvider([{ input: VALID_OPS }]);

      const reply = await refineTurn(provider, context, [{ role: "user", content: "Tighten it." }]);
      store.saveSuggestion(reply.suggestion!);

      expect(store.listSuggestions(doc.id)).toHaveLength(1);

      const { entity, revision } = applySuggestion(store, reply.suggestion!.id, [0]);
      expect(entity.body).toContain("single MCP call");
      expect(store.listRevisions(doc.id)).toHaveLength(1);
      expect(revision.body).toBe(entity.body);
    } finally {
      store.close();
    }
  });
});

describe("refineTurn — multi-turn context retention (c)", () => {
  it("passes the whole history to the model and appends replies onto it", async () => {
    const { provider, requests } = scriptedProvider([
      { text: "It targets coding agents." },
      { text: "As established, coding agents — so the criterion should name them." },
    ]);

    const history: Message[] = [{ role: "user", content: "Who is the audience?" }];
    const first = await refineTurn(provider, CONTEXT, history);
    history.push(first.assistantMessage, { role: "user", content: "Then who should the criterion mention?" });
    const second = await refineTurn(provider, CONTEXT, history);

    // The second request carries turn 1's Q, the assistant's answer, and turn 2's Q.
    const secondMessages = requests[1].messages;
    expect(secondMessages).toHaveLength(3);
    expect(secondMessages[0].content).toContain("Who is the audience?");
    expect(secondMessages[1].content).toBe("It targets coding agents.");
    expect(secondMessages[2].content).toContain("criterion mention?");
    expect(second.text).toContain("coding agents");
  });
});

describe("refineTurn — invalid ops are rejected, retried, and surfaced (d)", () => {
  it("retries with the validation error when the model emits bad ops", async () => {
    const malformed = { ops: [{ kind: "explode", anchor: "x" }] };
    const { provider, requests } = scriptedProvider([{ input: malformed }, { input: VALID_OPS }]);

    const reply = await refineTurn(provider, CONTEXT, [{ role: "user", content: "Change it." }]);

    expect(reply.suggestion!.ops).toEqual(VALID_OPS.ops);
    expect(requests).toHaveLength(2);
    const retry = requests[1].messages;
    expect(retry.at(-1)?.content).toContain("rejected");
    expect(retry.at(-2)?.content).toContain("explode");
  });

  it("throws RefineError after exhausting attempts and files nothing", async () => {
    const store = new SqliteStore(":memory:");
    try {
      const doc = store.createEntity({ type: "requirement", title: "Traceable handoff", body: DOC.body });
      const context: RefineContext = { ...CONTEXT, document: doc };
      const { provider, requests } = scriptedProvider([{ input: { ops: [] } }]);

      await expect(
        refineTurn(provider, context, [{ role: "user", content: "Break it." }], { maxAttempts: 2 }),
      ).rejects.toThrow(RefineError);
      expect(requests).toHaveLength(2);
      // Nothing was applied: no suggestion filed, body untouched.
      expect(store.listSuggestions(doc.id)).toHaveLength(0);
      expect(store.getEntity(doc.id)!.body).toBe(DOC.body);
    } finally {
      store.close();
    }
  });

  it("rejects an empty history and a non-user final turn", async () => {
    const { provider } = scriptedProvider([{ text: "hi" }]);
    await expect(refineTurn(provider, CONTEXT, [])).rejects.toThrow(RefineError);
    await expect(
      refineTurn(provider, CONTEXT, [{ role: "assistant", content: "unsolicited" }]),
    ).rejects.toThrow(RefineError);
  });
});

describe("assembleRefineContext", () => {
  it("assembles a requirement's blueprints, artifacts, parents, and children from the graph", () => {
    const store = new SqliteStore(":memory:");
    try {
      const root = store.createEntity({ type: "requirement", title: "Root", body: "root intent" });
      const req = store.createEntity({ type: "requirement", title: "Feature", body: "feature intent" });
      const child = store.createEntity({ type: "requirement", title: "Sub", body: "sub intent" });
      const bp = store.createEntity({ type: "blueprint", title: "Design", body: "how" });
      const art = store.createEntity({ type: "artifact", title: "Notes", body: "source" });
      store.link(req.id, root.id, "child_of");
      store.link(child.id, req.id, "child_of");
      store.link(bp.id, req.id, "details");
      store.link(req.id, art.id, "references");

      const ctx = assembleRefineContext(store, req.id);
      expect(ctx.document.id).toBe(req.id);
      expect(ctx.requirement).toBeNull(); // the doc IS the requirement
      expect(ctx.blueprints.map((b) => b.id)).toEqual([bp.id]);
      expect(ctx.parents.map((p) => p.id)).toEqual([root.id]);
      expect(ctx.children.map((c) => c.id)).toEqual([child.id]);
      expect(ctx.artifacts.map((a) => a.id)).toEqual([art.id]);
    } finally {
      store.close();
    }
  });

  it("inherits ancestor artifacts nearest-first, deduped against the document's own", () => {
    const store = new SqliteStore(":memory:");
    try {
      // root(aRoot, aShared) <- mid(aMid) <- doc(aDoc, aShared)
      const aRoot = store.createEntity({ type: "artifact", title: "Root PRD", body: "why" });
      const aShared = store.createEntity({ type: "artifact", title: "Shared", body: "both" });
      const aMid = store.createEntity({ type: "artifact", title: "Mid notes", body: "mid" });
      const aDoc = store.createEntity({ type: "artifact", title: "Doc spec", body: "doc" });
      const root = store.createEntity({ type: "requirement", title: "root" });
      const mid = store.createEntity({ type: "requirement", title: "mid" });
      const doc = store.createEntity({ type: "requirement", title: "doc" });
      store.link(mid.id, root.id, "child_of");
      store.link(doc.id, mid.id, "child_of");
      store.link(root.id, aRoot.id, "references");
      store.link(root.id, aShared.id, "references");
      store.link(mid.id, aMid.id, "references");
      store.link(doc.id, aDoc.id, "references");
      store.link(doc.id, aShared.id, "references"); // doc owns aShared — nearest wins

      const ctx = assembleRefineContext(store, doc.id);
      // Own artifacts (level 0) unchanged.
      expect(ctx.artifacts.map((a) => a.id).sort()).toEqual([aDoc.id, aShared.id].sort());
      // Nearest-first (mid before root); aShared dropped from root (owned at level 0).
      expect(ctx.inheritedArtifacts.map((a) => a.id)).toEqual([aMid.id, aRoot.id]);

      // The inherited artifacts reach the prompt.
      const system = buildRefineSystemPrompt(ctx);
      expect(system).toContain("Inherited artifacts");
      expect(system).toContain("Mid notes");
    } finally {
      store.close();
    }
  });

  it("inherits ancestor details blueprints nearest-first, one per ancestor by (title, id) (Phase 14)", () => {
    const store = new SqliteStore(":memory:");
    try {
      // root(two BPs — deterministic pick) <- mid(no BP) <- doc
      const root = store.createEntity({ type: "requirement", title: "root", body: "product overview" });
      const mid = store.createEntity({ type: "requirement", title: "mid" });
      const doc = store.createEntity({ type: "requirement", title: "doc" });
      store.link(mid.id, root.id, "child_of");
      store.link(doc.id, mid.id, "child_of");
      const bpB = store.createEntity({ type: "blueprint", title: "b arch", body: "later" });
      const bpA = store.createEntity({ type: "blueprint", title: "a arch", body: "the system overview" });
      store.link(bpB.id, root.id, "details");
      store.link(bpA.id, root.id, "details");

      const ctx = assembleRefineContext(store, doc.id);
      // mid has no details blueprint — nothing pushed for it; root picks "a arch".
      expect(ctx.inheritedBlueprints.map((b) => b.id)).toEqual([bpA.id]);

      // The inherited blueprint reaches the prompt (and review, via the shared prompt).
      const system = buildRefineSystemPrompt(ctx);
      expect(system).toContain("Inherited blueprints");
      expect(system).toContain("the system overview");

      // A flat document renders no inherited-blueprints section.
      const flat = assembleRefineContext(store, root.id);
      expect(flat.inheritedBlueprints).toEqual([]);
      expect(buildRefineSystemPrompt(flat)).not.toContain("Inherited blueprints");
    } finally {
      store.close();
    }
  });

  it("resolves a blueprint to its paired requirement and that requirement's artifacts", () => {
    const store = new SqliteStore(":memory:");
    try {
      const req = store.createEntity({ type: "requirement", title: "Feature", body: "intent" });
      const bp = store.createEntity({ type: "blueprint", title: "Design", body: "how" });
      const art = store.createEntity({ type: "artifact", title: "Notes", body: "source" });
      store.link(bp.id, req.id, "details");
      store.link(req.id, art.id, "references");

      const ctx = assembleRefineContext(store, bp.id);
      expect(ctx.document.id).toBe(bp.id);
      expect(ctx.requirement?.id).toBe(req.id);
      expect(ctx.artifacts.map((a) => a.id)).toEqual([art.id]);
      expect(ctx.blueprints).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("refuses to refine a non-document entity", () => {
    const store = new SqliteStore(":memory:");
    try {
      const wo = store.createEntity({ type: "work_order", title: "Do it", body: "x", status: "draft" });
      expect(() => assembleRefineContext(store, wo.id)).toThrow(/only requirements and blueprints/);
    } finally {
      store.close();
    }
  });
});
