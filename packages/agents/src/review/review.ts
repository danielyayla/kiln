import { randomUUID } from "node:crypto";
import { z } from "zod";
import { EditOp, Suggestion, type AuthoringSkill } from "@kiln/core";
import type { Message, ModelProvider, Tool } from "../model/index.js";
import { EDIT_OPS_JSON_SCHEMA } from "../draft/index.js";
import { buildRefineSystemPrompt, type RefineContext } from "../refine/index.js";

// The review agent (FRD Phase 5): an on-demand quality pass over one document.
// Observations that need discussion come back as structured findings; concrete
// fixes ride along as OPTIONAL suggestion ops through the same schema and
// gates as drafting — never a silent rewrite.

export const FINDING_SEVERITIES = ["minor", "major", "critical"] as const;
export const FINDING_KINDS = ["ambiguity", "gap", "conflict", "duplication"] as const;

export const Finding = z.object({
  severity: z.enum(FINDING_SEVERITIES),
  kind: z.enum(FINDING_KINDS),
  note: z.string().min(1),
  // The offending passage, verbatim. Empty for document-wide findings (a gap
  // has nothing to quote).
  quote: z.string(),
});
export type Finding = z.infer<typeof Finding>;

// What the model must emit. Zero findings is a legal, meaningful result (a
// clean document); ops are optional and only for fixes concrete enough to
// apply verbatim.
const EmittedReview = z.object({
  findings: z.array(Finding),
  ops: z.array(EditOp).min(1).optional(),
});

export const EMIT_REVIEW_TOOL: Tool = {
  name: "emit_review",
  description:
    "Emit the review: a findings list (may be empty for a clean document), plus optional edit operations for fixes concrete enough to apply.",
  inputSchema: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { enum: [...FINDING_SEVERITIES] },
            kind: { enum: [...FINDING_KINDS] },
            note: { type: "string", description: "What is wrong and why it matters, one or two sentences." },
            quote: {
              type: "string",
              description:
                "The offending passage quoted verbatim from the document. Empty string for document-wide findings.",
            },
          },
          required: ["severity", "kind", "note", "quote"],
          additionalProperties: false,
        },
      },
      ops: EDIT_OPS_JSON_SCHEMA,
    },
    required: ["findings"],
    additionalProperties: false,
  },
};

export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewError";
  }
}

// Builds the review prompts. The system prompt reuses the refine context
// rendering (document body + linked neighbourhood) so review sees exactly what
// chat sees — including the requirement/blueprint pair, which is what makes
// drift findings possible. Exported for tests.
export function buildReviewPrompt(
  context: RefineContext,
  skills: AuthoringSkill[] = [],
): { system: string; user: string } {
  // buildRefineSystemPrompt carries the document + context and the shared
  // anchor rules (plus any active authoring skills); the review framing below
  // overrides the conversational parts.
  const contextBlock = buildRefineSystemPrompt(context, skills);

  const system = `You are a document reviewer for ${context.document.type} documents in an SDLC knowledge graph.

${contextBlock}

Review task (this overrides the conversational instructions above):
- Read the document against its linked context and flag exactly four kinds of problems:
  - ambiguity: wording a builder or coding agent could read two ways
  - gap: something the document must state but doesn't (unstated behaviour, missing acceptance criterion, undefined term)
  - conflict: the document contradicts itself or its linked context — e.g. a blueprint promising something its requirement never asks for
  - duplication: the same rule or requirement stated twice, risking divergence
- Every finding: severity (minor|major|critical), kind, a 1–2 sentence note, and the offending passage quoted VERBATIM (empty quote only for document-wide findings).
- When a fix is concrete enough to apply verbatim, also emit edit ops for it (same anchor rules as above). Ops are optional — never force a rewrite for a finding that needs discussion.
- A clean document gets an empty findings list. Do not invent problems.
- Reply ONLY via the emit_review tool.`;

  const user = `Review this ${context.document.type} now.`;

  return { system, user };
}

// One on-demand review pass. Returns validated findings plus at most one
// Suggestion (source: review_agent) when the model proposed concrete fixes;
// persisting the suggestion is the caller's job — same contract as drafting.
export interface ReviewResult {
  findings: Finding[];
  suggestion: Suggestion | null;
}

export interface ReviewOptions {
  /** Total model attempts before giving up (default 3). */
  maxAttempts?: number;
  /** Active authoring skills, injected ahead of the assembled context. */
  skills?: AuthoringSkill[];
}

export async function reviewDocument(
  provider: ModelProvider,
  context: RefineContext,
  options: ReviewOptions = {},
): Promise<ReviewResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  const { system, user } = buildReviewPrompt(context, options.skills ?? []);
  const messages: Message[] = [{ role: "user", content: user }];

  let lastFailure = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await provider.complete({
      system,
      messages,
      tools: [EMIT_REVIEW_TOOL],
      tier: "reason",
    });

    if (result.toolCall?.name === EMIT_REVIEW_TOOL.name) {
      const parsed = EmittedReview.safeParse(result.toolCall.input);
      if (parsed.success) {
        const suggestion = parsed.data.ops
          ? Suggestion.parse({
              id: randomUUID(),
              targetId: context.document.id,
              source: "review_agent",
              ops: parsed.data.ops,
            })
          : null;
        return { findings: parsed.data.findings, suggestion };
      }
      lastFailure = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
    } else {
      lastFailure = "no emit_review tool call in the reply";
    }

    // Feed the rejection back so the retry can correct itself.
    messages.push(
      {
        role: "assistant",
        content: JSON.stringify(result.toolCall?.input ?? result.text ?? null),
      },
      {
        role: "user",
        content: `That output was rejected: ${lastFailure}. Call emit_review again with a corrected payload matching the schema exactly.`,
      },
    );
  }

  throw new ReviewError(
    `model produced no valid review after ${maxAttempts} attempts (last failure: ${lastFailure})`,
  );
}
