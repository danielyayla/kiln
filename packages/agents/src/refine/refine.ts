import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ancestors,
  ConstraintError,
  EditOp,
  NotFoundError,
  Suggestion,
  type AuthoringSkill,
  type Entity,
  type Id,
  type Store,
} from "@kiln/core";
import type { Message, ModelProvider } from "../model/index.js";
import { EMIT_SUGGESTION_TOOL } from "../draft/index.js";

// The refine agent proposes edits through the SAME op schema as drafting; Zod
// is the final arbiter at the boundary (BP-4). Reusing EMIT_SUGGESTION_TOOL
// keeps one JSON-Schema definition of an edit op across every authoring agent.
const EmittedSuggestion = z.object({ ops: z.array(EditOp).min(1) });

export class RefineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefineError";
  }
}

// A chat scoped to one document (requirement or blueprint) plus its assembled
// graph neighbourhood. The model answers questions against this context and may
// propose edits to `document` — never to the neighbours.
export interface RefineContext {
  /** The document the conversation is scoped to. */
  document: Entity;
  /** The paired requirement when `document` is a blueprint (its `details` target). */
  requirement: Entity | null;
  /** Blueprints detailing `document` when it is a requirement (`details` sources). */
  blueprints: Entity[];
  /** Parent requirements up the child_of chain, nearest first. */
  parents: Entity[];
  /** Immediate child requirements. */
  children: Entity[];
  /** Artifacts referenced by the requirement in focus. */
  artifacts: Entity[];
  /**
   * Artifacts referenced by ancestor requirements, folded in nearest-first with
   * nearest-wins dedup against `artifacts` (Phase 6). Lets refine chat and review
   * see inherited source material, not just ancestor titles/bodies.
   */
  inheritedArtifacts: Entity[];
  /**
   * Each ancestor's `details` blueprint, nearest-first — one per ancestor, first
   * by (title, id), the same pick as core's lineage (Phase 14). Puts the product
   * root's architecture overview in front of refine chat and review.
   */
  inheritedBlueprints: Entity[];
}

// Assemble the chat's context by walking the graph from one document. Mirrors
// assembleWorkOrderContext's philosophy: missing links yield empty sections,
// never an error, so a sparsely-linked document still chats. The desktop
// sidecar (WO-A2) calls this; the model loop below stays store-free for tests.
export function assembleRefineContext(store: Store, documentId: Id): RefineContext {
  const document = store.getEntity(documentId);
  if (!document) throw new NotFoundError(documentId);
  if (document.type !== "requirement" && document.type !== "blueprint") {
    throw new ConstraintError(
      `refine target ${documentId} is a ${document.type}; only requirements and blueprints can be refined`,
    );
  }

  // The requirement in focus is the document itself (when it is a requirement)
  // or the requirement the blueprint details. Artifacts and the requirement
  // tree hang off that requirement.
  const requirement =
    document.type === "requirement" ? document : (store.linked(document.id, "details")[0] ?? null);
  const blueprints = document.type === "requirement" ? store.linkedFrom(document.id, "details") : [];
  const parents = requirement ? ancestors(store, requirement.id) : [];
  const children = requirement ? store.children(requirement.id) : [];
  const artifacts = requirement ? store.linked(requirement.id, "references") : [];

  // Inherit ancestor artifacts, nearest-first, deduped against the document's
  // own (level 0). Same nearest-wins rule as core's assembleWorkOrderContext, so
  // chat/review see the same inherited intent a work order under this document
  // would (Phase 6).
  const seen = new Set(artifacts.map((a) => a.id));
  const inheritedArtifacts: Entity[] = [];
  const inheritedBlueprints: Entity[] = [];
  for (const parent of parents) {
    for (const a of store.linked(parent.id, "references")) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      inheritedArtifacts.push(a);
    }
    // One blueprint per ancestor, first by (title, id) — mirrors core's
    // LineageEntry.blueprint so chat/review see what a work order would.
    const detailing = store
      .linkedFrom(parent.id, "details")
      .filter((b) => b.type === "blueprint")
      .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    if (detailing[0]) inheritedBlueprints.push(detailing[0]);
  }

  return {
    document,
    requirement: document.type === "requirement" ? null : requirement,
    blueprints,
    parents,
    children,
    artifacts,
    inheritedArtifacts,
    inheritedBlueprints,
  };
}

// Builds the system prompt from the document body + assembled context. Exported
// so tests can assert context flows into the prompt without a model call.
// `skills` are user-authored authoring standards (resolved in core — agents
// never touch the store); when present they render at system-prompt strength
// ahead of the assembled context. Absent/empty skills leave the prompt
// byte-identical to the zero-skill baseline.
export function buildRefineSystemPrompt(
  context: RefineContext,
  skills: AuthoringSkill[] = [],
): string {
  const { document } = context;

  const sections: string[] = [];
  const add = (label: string, entities: Entity[]) => {
    if (entities.length === 0) return;
    const rendered = entities.map((e) => `### ${e.type}: ${e.title}\n${e.body}`).join("\n\n");
    sections.push(`## ${label}\n${rendered}`);
  };

  if (context.requirement) add("Requirement this blueprint details", [context.requirement]);
  add("Blueprints detailing this requirement", context.blueprints);
  add("Parent requirements", context.parents);
  add("Child requirements", context.children);
  add("Referenced artifacts", context.artifacts);
  add("Inherited artifacts (from ancestor requirements)", context.inheritedArtifacts);
  add("Inherited blueprints (from ancestor requirements)", context.inheritedBlueprints);

  const contextBlock =
    sections.length === 0 ? "(no linked context)" : sections.join("\n\n");

  const skillsBlock =
    skills.length === 0
      ? ""
      : `Authoring skills (house standards — follow these):
${skills.map((s) => `## ${s.title}\n${s.body}`).join("\n\n")}

`;

  return `You are refining one ${document.type} through conversation with its author.

The document in focus (between <document> markers):
<document>
${document.body}
</document>

${skillsBlock}Linked context (read-only — you may cite it but never edit it):
${contextBlock}

How to reply:
- Answer questions directly and ground every answer in the document or a named artifact/section. If the document does not say, say so.
- When the author asks for a change — or you propose one — call the emit_suggestion tool with anchor-addressed edit ops against the CURRENT document body. Do NOT paste the rewritten document in prose.
- You may both answer in prose AND emit a suggestion in the same turn. If no edit is warranted, just answer — do not call the tool.
- Every anchor must be an exact substring of the current document body that occurs exactly once. To append (or edit an empty document), use an insert op with an empty anchor.
- Never rewrite the whole document when a targeted edit will do; each op should be independently acceptable.
- You never write the document body directly — every change is a suggestion the author accepts or rejects per op.

House authoring standards:
- Follow the house authoring methodology when proposing edits: requirements state a capability with explicit Non-goals and verifiable Success criteria; blueprints record decisions with rejected alternatives and what is untouched; work orders carry Scope, Out of scope, and a "- [ ]" acceptance checklist.
- If an authoring-standards / methodology document appears in the linked or inherited context, treat it as the house style — align structure and completeness suggestions with it rather than inventing your own conventions.`;
}

// What a single refine turn produced.
export interface RefineReply {
  /** The assistant's prose reply. Empty string when the turn only proposed an edit. */
  text: string;
  /** A Zod-valid Suggestion when the turn proposed an edit; null for pure Q&A. */
  suggestion: Suggestion | null;
  /**
   * The assistant message to append to the transcript before the next turn.
   * Never empty (Message requires non-empty content) — a tool-only turn is
   * summarised so later turns retain that an edit was proposed.
   */
  assistantMessage: Message;
}

export interface RefineOptions {
  /** Total model attempts to obtain valid ops once the model chose to emit (default 3). */
  maxAttempts?: number;
  /** Active authoring skills, injected ahead of the assembled context. */
  skills?: AuthoringSkill[];
}

// One turn of the refine conversation (BP-4). `history` is the session so far,
// oldest first, ending with the author's new user message — the caller owns it
// (transcripts are session-local, never persisted for this WO). Returns prose
// and/or at most one Zod-valid Suggestion; persisting it is the caller's job.
//
// The emit tool is offered with `toolChoice: "auto"` so the model can answer in
// prose OR propose an edit. It only retries when the model DID emit ops that
// fail validation — invalid ops are surfaced (RefineError), never applied.
export async function refineTurn(
  provider: ModelProvider,
  context: RefineContext,
  history: Message[],
  options: RefineOptions = {},
): Promise<RefineReply> {
  if (history.length === 0) throw new RefineError("refine requires at least one user message");
  if (history[history.length - 1].role !== "user") {
    throw new RefineError("the last message in the history must be the author's user turn");
  }

  const maxAttempts = options.maxAttempts ?? 3;
  const system = buildRefineSystemPrompt(context, options.skills ?? []);
  const messages: Message[] = [...history];

  let lastFailure = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await provider.complete({
      system,
      messages,
      tools: [EMIT_SUGGESTION_TOOL],
      toolChoice: "auto",
      tier: "reason",
    });

    // Pure Q&A: the model answered without proposing an edit. Terminal.
    if (result.toolCall?.name !== EMIT_SUGGESTION_TOOL.name) {
      const text = result.text.trim();
      if (!text) {
        // No prose and no tool call is a degenerate reply; treat as a retryable
        // miss rather than returning an empty turn.
        lastFailure = "the model returned neither an answer nor an edit";
      } else {
        return { text, suggestion: null, assistantMessage: { role: "assistant", content: text } };
      }
    } else {
      const parsed = EmittedSuggestion.safeParse(result.toolCall.input);
      if (parsed.success) {
        const suggestion = Suggestion.parse({
          id: randomUUID(),
          targetId: context.document.id,
          source: "refine_agent",
          ops: parsed.data.ops,
        });
        const text = result.text.trim();
        return {
          text,
          suggestion,
          assistantMessage: {
            role: "assistant",
            content: text || `(proposed a suggestion with ${suggestion.ops.length} edit op${suggestion.ops.length === 1 ? "" : "s"})`,
          },
        };
      }
      lastFailure = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
    }

    // Feed the rejection back so the retry can correct itself.
    messages.push(
      {
        role: "assistant",
        content: JSON.stringify(result.toolCall?.input ?? result.text ?? null),
      },
      {
        role: "user",
        content: `That edit was rejected: ${lastFailure}. Either call emit_suggestion again with a corrected ops array matching the schema exactly, or answer in prose if no edit is warranted.`,
      },
    );
  }

  throw new RefineError(
    `model produced no valid reply after ${maxAttempts} attempts (last failure: ${lastFailure})`,
  );
}
