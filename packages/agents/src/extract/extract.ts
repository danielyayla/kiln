import { z } from "zod";
import {
  ConstraintError,
  NotFoundError,
  type AuthoringSkill,
  type Entity,
  type Id,
  type Store,
} from "@kiln/core";
import type { Message, ModelProvider, Tool } from "../model/index.js";
import { templateSectionFromSkills } from "../draft/templates.js";

// A proposed unit of work pulled out of a blueprint (BP-4): title + body.
// Candidates are proposals — nothing touches the store until one is accepted.
export const WorkOrderCandidate = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
});
export type WorkOrderCandidate = z.infer<typeof WorkOrderCandidate>;

const EmittedCandidates = z.object({ candidates: z.array(WorkOrderCandidate).min(1) });

export const EMIT_WORK_ORDERS_TOOL: Tool = {
  name: "emit_work_orders",
  description: "Emit the candidate work orders extracted from the blueprint.",
  inputSchema: {
    type: "object",
    properties: {
      candidates: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            title: { type: "string", description: "Short imperative title for the unit of work." },
            body: {
              type: "string",
              description:
                "What to build and how to verify it is done, self-contained enough for a coding agent.",
            },
          },
          required: ["title", "body"],
          additionalProperties: false,
        },
      },
    },
    required: ["candidates"],
    additionalProperties: false,
  },
};

export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractError";
  }
}

// Exported for tests: the prompt is derived from the blueprint plus any active
// authoring skills. A skill's `## Template: work-order` section replaces the
// house work-order shape verbatim; empty/absent skills leave the prompt
// byte-identical to the zero-skill baseline.
export function buildExtractPrompt(
  blueprint: Entity,
  skills: AuthoringSkill[] = [],
): { system: string; user: string } {
  const override = templateSectionFromSkills(skills, "work-order");
  const shapeRule = override
    ? `- Each body follows this structure exactly:
${override}`
    : `- Each body follows the house work-order shape:
  "## Scope" (what this delivers and where it stops),
  "## Out of scope" (what an eager agent might do but must not),
  "## Acceptance criteria" (a "- [ ]" checklist, each item independently checkable — a work order without one cannot be set ready),
  "## Implementation hints" (files likely to change / must not change / things to reuse — only when inferable from the blueprint).`;

  const skillsBlock =
    skills.length === 0
      ? ""
      : `

Authoring skills (house standards — follow these):
${skills.map((s) => `## ${s.title}\n${s.body}`).join("\n\n")}`;

  const system = `You break technical blueprints into work orders: independently implementable units of work for a coding agent.

Rules:
- Each candidate must be a coherent, self-contained unit — one seam of the blueprint, not a sliver of one.
- Order candidates so earlier ones unblock later ones.
${shapeRule}
- Emit the candidates via the emit_work_orders tool.${skillsBlock}`;

  const user = `Blueprint: ${blueprint.title}

<blueprint>
${blueprint.body}
</blueprint>

Extract the candidate work orders.`;

  return { system, user };
}

export interface ExtractOptions {
  /** Total model attempts before giving up (default 3). */
  maxAttempts?: number;
  /** Active authoring skills, injected into the extraction prompt. */
  skills?: AuthoringSkill[];
}

// The extraction agent (BP-4): blueprint in, candidate work orders out.
// Candidates are returned for per-candidate accept/reject; acceptCandidate
// below is the accept path.
export async function extractWorkOrders(
  provider: ModelProvider,
  blueprint: Entity,
  options: ExtractOptions = {},
): Promise<WorkOrderCandidate[]> {
  if (blueprint.type !== "blueprint") {
    throw new ConstraintError(`extraction target ${blueprint.id} is a ${blueprint.type}, not a blueprint`);
  }
  const maxAttempts = options.maxAttempts ?? 3;
  const { system, user } = buildExtractPrompt(blueprint, options.skills ?? []);
  const messages: Message[] = [{ role: "user", content: user }];

  let lastFailure = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await provider.complete({
      system,
      messages,
      tools: [EMIT_WORK_ORDERS_TOOL],
      tier: "reason",
    });

    if (result.toolCall?.name === EMIT_WORK_ORDERS_TOOL.name) {
      const parsed = EmittedCandidates.safeParse(result.toolCall.input);
      if (parsed.success) return parsed.data.candidates;
      lastFailure = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
    } else {
      lastFailure = "no emit_work_orders tool call in the reply";
    }

    messages.push(
      { role: "assistant", content: JSON.stringify(result.toolCall?.input ?? result.text ?? null) },
      {
        role: "user",
        content: `That output was rejected: ${lastFailure}. Call emit_work_orders again with a corrected candidates array matching the schema exactly.`,
      },
    );
  }

  throw new ExtractError(
    `model produced no valid work-order candidates after ${maxAttempts} attempts (last failure: ${lastFailure})`,
  );
}

// Accepting a candidate is what makes it real: a `work_order` entity in
// `draft` status, linked implements → blueprint so context assembly can walk
// back to the intent chain.
export function acceptCandidate(store: Store, blueprintId: Id, candidate: WorkOrderCandidate): Entity {
  const data = WorkOrderCandidate.parse(candidate);
  const blueprint = store.getEntity(blueprintId);
  if (!blueprint) throw new NotFoundError(blueprintId);
  if (blueprint.type !== "blueprint") {
    throw new ConstraintError(`entity ${blueprintId} is a ${blueprint.type}, not a blueprint`);
  }

  const workOrder = store.createEntity({
    type: "work_order",
    title: data.title,
    body: data.body,
    status: "draft",
  });
  store.link(workOrder.id, blueprintId, "implements");
  return store.getEntity(workOrder.id)!;
}
