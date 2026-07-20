import { randomUUID } from "node:crypto";
import { z } from "zod";
import { EditOp, Suggestion, type AuthoringSkill, type Entity } from "@kiln/core";
import type { Message, ModelProvider, Tool } from "../model/index.js";
import { templateSectionFromSkills, type DraftTemplate } from "./templates.js";

// The shape the model must emit: an ordered list of EditOps (BP-4).
const EmittedSuggestion = z.object({ ops: z.array(EditOp).min(1) });

// JSON-Schema mirror of the EditOp union, shared by every emit tool that
// carries edit ops (draft, review). Zod's EditOp is the final arbiter at the
// boundary — this only shapes what the model is asked for.
export const EDIT_OPS_JSON_SCHEMA = {
  type: "array",
  minItems: 1,
  items: {
    anyOf: [
      {
        type: "object",
        properties: {
          kind: { const: "insert" },
          anchor: {
            type: "string",
            description:
              "Existing text to insert after. Empty string appends to the end of the document.",
          },
          text: { type: "string", description: "The text to insert." },
        },
        required: ["kind", "anchor", "text"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: { const: "delete" },
          anchor: { type: "string", description: "Exact existing text to delete." },
        },
        required: ["kind", "anchor"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          kind: { const: "replace" },
          anchor: { type: "string", description: "Exact existing text to replace." },
          text: { type: "string", description: "The replacement text." },
        },
        required: ["kind", "anchor", "text"],
        additionalProperties: false,
      },
    ],
  },
} as const;

// The provider forces this tool, so every reply is a schema-shaped ops list.
export const EMIT_SUGGESTION_TOOL: Tool = {
  name: "emit_suggestion",
  description:
    "Emit the drafted change as an ordered list of edit operations against the target document.",
  inputSchema: {
    type: "object",
    properties: { ops: EDIT_OPS_JSON_SCHEMA },
    required: ["ops"],
    additionalProperties: false,
  },
};

export class DraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftError";
  }
}

export interface DraftInput {
  /** The requirement or blueprint being drafted into. */
  target: Entity;
  /** Source material the draft must be grounded in. */
  artifacts: Entity[];
  /** House style controlling the drafted document's structure. */
  template: DraftTemplate;
  /**
   * Active authoring skills (resolved in core — agents never touch the store).
   * Rendered ahead of the edit rules; a `## Template: <type>` section matching
   * the target type replaces the built-in template's structure verbatim.
   */
  skills?: AuthoringSkill[];
}

// Builds the prompt pair. Exported so tests can assert the template drives
// the structure without a model call.
export function buildDraftPrompt(input: DraftInput): { system: string; user: string } {
  const { target, artifacts, template } = input;
  const skills = input.skills ?? [];

  // A skill-declared template for the target type wins over the built-in one;
  // the built-in guidance is the built-in template's voice, so it is dropped
  // alongside its structure.
  const override = templateSectionFromSkills(
    skills,
    target.type === "work_order" ? "work-order" : (target.type as "requirement" | "blueprint"),
  );
  const structure = override ?? template.structure;
  const guidance = override ? undefined : template.guidance;

  const skillsBlock =
    skills.length === 0
      ? ""
      : `Authoring skills (house standards — follow these):
${skills.map((s) => `## ${s.title}\n${s.body}`).join("\n\n")}

`;

  const system = `You draft ${template.kind} documents as precise, per-operation edits.

The drafted document MUST follow this structure:
${structure}
${guidance ? `\nStyle guidance: ${guidance}\n` : ""}
${skillsBlock}Edit rules:
- Express the draft as edit operations against the CURRENT document body via the emit_suggestion tool.
- Every anchor must be an exact substring of the current body that occurs exactly once.
- To append (or draft into an empty document), use an insert op with an empty anchor.
- Never rewrite the whole document when a targeted edit will do; each op should be independently acceptable.`;

  const artifactSection =
    artifacts.length === 0
      ? "(no artifacts provided)"
      : artifacts
          .map((a) => `### Artifact: ${a.title}\n${a.body}`)
          .join("\n\n");

  const user = `Target ${target.type}: ${target.title}

Current document body (between <body> markers):
<body>
${target.body}
</body>

Source artifacts:
${artifactSection}

Draft the ${target.type} content from the artifacts, following the required structure.`;

  return { system, user };
}

export interface DraftOptions {
  /** Total model attempts before giving up (default 3). */
  maxAttempts?: number;
}

// The drafting agent (BP-4): asks the model for edit ops through the forced
// emit tool, Zod-validates the reply, and retries with the validation error
// on malformed output. Returns a Zod-valid Suggestion; persisting it is the
// caller's job.
export async function draftSuggestion(
  provider: ModelProvider,
  input: DraftInput,
  options: DraftOptions = {},
): Promise<Suggestion> {
  const maxAttempts = options.maxAttempts ?? 3;
  const { system, user } = buildDraftPrompt(input);
  const messages: Message[] = [{ role: "user", content: user }];

  let lastFailure = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await provider.complete({
      system,
      messages,
      tools: [EMIT_SUGGESTION_TOOL],
      tier: "reason",
    });

    if (result.toolCall?.name === EMIT_SUGGESTION_TOOL.name) {
      const parsed = EmittedSuggestion.safeParse(result.toolCall.input);
      if (parsed.success) {
        return Suggestion.parse({
          id: randomUUID(),
          targetId: input.target.id,
          source: "draft_agent",
          ops: parsed.data.ops,
        });
      }
      lastFailure = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
    } else {
      lastFailure = "no emit_suggestion tool call in the reply";
    }

    // Feed the rejection back so the retry can correct itself.
    messages.push(
      {
        role: "assistant",
        content: JSON.stringify(result.toolCall?.input ?? result.text ?? null),
      },
      {
        role: "user",
        content: `That output was rejected: ${lastFailure}. Call emit_suggestion again with a corrected ops array matching the schema exactly.`,
      },
    );
  }

  throw new DraftError(
    `model produced no valid suggestion after ${maxAttempts} attempts (last failure: ${lastFailure})`,
  );
}
