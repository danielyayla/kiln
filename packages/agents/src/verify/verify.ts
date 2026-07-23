import {
  VerificationVerdict,
  VERDICT_STATUSES,
  type CompletionReceipt,
  type WorkOrderContext,
} from "@kiln/core";
import type { Message, ModelProvider, Tool } from "../model/index.js";

// The verify agent (verification & criticality feature): an independent judge
// of a done work order's completion receipt(s) against its acceptance
// criteria. It judges testimony, never code — input is the assembled context
// plus the receipts, nothing else — and it returns data only; recording the
// verdict as a verification receipt is the caller's job (sidecar/CLI).

export const EMIT_VERDICT_TOOL: Tool = {
  name: "emit_verdict",
  description:
    "Emit the verification verdict: one entry per acceptance criterion (met | unmet | undecidable, with a reason grounded in the completion receipts), plus the overall verdict. An order without acceptance criteria gets an empty criteria list and an undecidable overall.",
  inputSchema: {
    type: "object",
    properties: {
      criteria: {
        type: "array",
        items: {
          type: "object",
          properties: {
            criterion: {
              type: "string",
              description: "The acceptance criterion being judged, quoted from the work order.",
            },
            status: { enum: [...VERDICT_STATUSES] },
            reason: {
              type: "string",
              description:
                "Why this status: what in the receipts supports it, or what the receipts fail to say. One or two sentences.",
            },
          },
          required: ["criterion", "status", "reason"],
          additionalProperties: false,
        },
      },
      overall: { enum: [...VERDICT_STATUSES] },
    },
    required: ["criteria", "overall"],
    additionalProperties: false,
  },
};

export class VerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifyError";
  }
}

function renderReceipt(r: CompletionReceipt, index: number): string {
  const lines = [
    `### Completion receipt ${index + 1} (${r.createdAt})`,
    `Summary: ${r.summary}`,
    `Verification: ${r.verification}`,
  ];
  if (r.commits.length > 0) lines.push(`Commits: ${r.commits.join(", ")}`);
  if (r.branch) lines.push(`Branch: ${r.branch}`);
  if (r.filesTouched.length > 0) lines.push(`Files touched: ${r.filesTouched.join(", ")}`);
  return lines.join("\n");
}

// Builds the verify prompts. Deliberately narrower than the full assembled
// context: the work order (where the acceptance criteria live) plus its
// blueprint and requirement for the meaning of terms. Lineage and artifacts
// are background for implementers, not evidence for a judge — including them
// would invite verdicts grounded in intent instead of testimony. Exported for
// tests.
export function buildVerifyPrompt(
  context: WorkOrderContext,
  receipts: CompletionReceipt[],
): { system: string; user: string } {
  const sections = [
    `## Work order: ${context.workOrder.title}\n${context.workOrder.body}`,
  ];
  if (context.blueprint) {
    sections.push(`## Blueprint (design context): ${context.blueprint.title}\n${context.blueprint.body}`);
  }
  if (context.requirement) {
    sections.push(
      `## Requirement (intent context): ${context.requirement.title}\n${context.requirement.body}`,
    );
  }
  sections.push(
    receipts.length === 0
      ? "## Completion receipts\n(none recorded)"
      : `## Completion receipts (oldest first)\n${receipts.map(renderReceipt).join("\n\n")}`,
  );

  const system = `You are an independent verifier in an SDLC knowledge graph. A work order was closed by a coding agent, and the agent filed completion receipts — its own testimony about what it built and how it verified it. Your job is to judge whether that testimony shows each acceptance criterion was met. You judge the receipts, never the code: no repository, diff, or test run is available to you, and you must not assume work happened that the receipts do not describe.

${sections.join("\n\n")}

Verification task:
- Extract the acceptance criteria from the work order body (typically the "Acceptance criteria" checklist). Judge each one against the completion receipts:
  - met: the receipts give concrete evidence the criterion was satisfied (named behavior, real test output, an explicit claim specific enough to check later).
  - unmet: the receipts show it was not satisfied, or claim something that contradicts it.
  - undecidable: the receipts are silent or too vague to judge either way. Silence is undecidable, NEVER met.
- Quote each criterion in its entry; give a one-or-two-sentence reason grounded in the receipts.
- overall: met only if every criterion is met; unmet if any criterion is unmet; otherwise undecidable.
- If the work order body contains no acceptance criteria, emit an empty criteria list with overall undecidable.
- If there are no completion receipts, every criterion is undecidable.
- Reply ONLY via the emit_verdict tool.`;

  const user = "Judge the completion receipts against the acceptance criteria now.";

  return { system, user };
}

export interface VerifyOptions {
  /** Total model attempts before giving up (default 3). */
  maxAttempts?: number;
}

// One verification pass. Returns the validated verdict (core's shared schema);
// the caller records it via recordVerificationReceipt. Mirrors the review
// agent's structured-output boundary: forced single emit tool, Zod at the
// seam, rejected output fed back for a corrected retry.
export async function verifyWorkOrder(
  provider: ModelProvider,
  context: WorkOrderContext,
  receipts: CompletionReceipt[],
  options: VerifyOptions = {},
): Promise<VerificationVerdict> {
  const maxAttempts = options.maxAttempts ?? 3;
  const { system, user } = buildVerifyPrompt(context, receipts);
  const messages: Message[] = [{ role: "user", content: user }];

  let lastFailure = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await provider.complete({
      system,
      messages,
      tools: [EMIT_VERDICT_TOOL],
      tier: "reason",
    });

    if (result.toolCall?.name === EMIT_VERDICT_TOOL.name) {
      const parsed = VerificationVerdict.safeParse(result.toolCall.input);
      if (parsed.success) return parsed.data;
      lastFailure = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
    } else {
      lastFailure = "no emit_verdict tool call in the reply";
    }

    // Feed the rejection back so the retry can correct itself.
    messages.push(
      {
        role: "assistant",
        content: JSON.stringify(result.toolCall?.input ?? result.text ?? null),
      },
      {
        role: "user",
        content: `That output was rejected: ${lastFailure}. Call emit_verdict again with a corrected payload matching the schema exactly.`,
      },
    );
  }

  throw new VerifyError(
    `model produced no valid verdict after ${maxAttempts} attempts (last failure: ${lastFailure})`,
  );
}
