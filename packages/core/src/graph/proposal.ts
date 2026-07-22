import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Id, Suggestion } from "../domain";
import { ConstraintError, NotFoundError } from "../errors";
import type { Store } from "../store";

const nonBlank = (field: string) =>
  z.string().refine((s) => s.trim().length > 0, {
    message: `${field} must not be empty or whitespace-only`,
  });

const proposedDocument = (label: string) =>
  z.object({
    title: nonBlank(`${label} title`),
    body: nonBlank(`${label} body`),
  });

// One proposed feature from a surveying agent: the requirement and blueprint
// bodies to file as gated suggestions, plus the evidence artifacts grounding
// them. Evidence is mandatory — a proposal without evidence is an invention.
export const ProposedFeature = z.object({
  requirement: proposedDocument("requirement"),
  blueprint: proposedDocument("blueprint"),
  evidence: z.array(proposedDocument("evidence")).min(1, "evidence must not be empty"),
});
export type ProposedFeature = z.input<typeof ProposedFeature>;

export interface ProposedFeatureIds {
  requirementId: Id;
  blueprintId: Id;
  artifactIds: Id[];
  requirementSuggestionId: Id;
  blueprintSuggestionId: Id;
}

const pendingBody = (targetId: Id, body: string): Suggestion => ({
  id: randomUUID(),
  targetId,
  source: "extract_agent",
  ops: [{ kind: "insert", anchor: "", text: body }],
});

// Materialize one proposed feature behind the suggestion gate: the requirement
// and blueprint are created EMPTY-bodied and their proposed bodies land as
// pending suggestions (the draft-agent shape — a single empty-anchor insert),
// so nothing is committed until a human accepts. Evidence artifacts are
// read-only source material and get their bodies directly, `references`-linked
// from the requirement so context assembly delivers them downstream.
//
// Validate-then-write: every rejection happens before the first store call.
// The store has no transaction seam, so an unexpected mid-write failure is
// compensated by deleting the created entities (cascade removes their links
// and suggestions).
export function proposeFeature(
  store: Store,
  parentRequirementId: Id,
  proposal: ProposedFeature,
): ProposedFeatureIds {
  const parsed = ProposedFeature.safeParse(proposal);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ConstraintError(`invalid feature proposal: ${issues}`);
  }
  const data = parsed.data;

  const parent = store.getEntity(parentRequirementId);
  if (!parent) throw new NotFoundError(parentRequirementId);
  if (parent.type !== "requirement") {
    throw new ConstraintError(
      `proposal parent ${parentRequirementId} is a ${parent.type}, not a requirement`,
    );
  }

  const created: Id[] = [];
  try {
    const requirement = store.createEntity({
      type: "requirement",
      title: data.requirement.title,
      body: "",
    });
    created.push(requirement.id);
    store.link(requirement.id, parent.id, "child_of");

    const blueprint = store.createEntity({
      type: "blueprint",
      title: data.blueprint.title,
      body: "",
    });
    created.push(blueprint.id);
    store.link(blueprint.id, requirement.id, "details");

    const artifactIds: Id[] = [];
    for (const evidence of data.evidence) {
      const artifact = store.createEntity({
        type: "artifact",
        title: evidence.title,
        body: evidence.body,
      });
      created.push(artifact.id);
      store.link(requirement.id, artifact.id, "references");
      artifactIds.push(artifact.id);
    }

    const requirementSuggestion = pendingBody(requirement.id, data.requirement.body);
    store.saveSuggestion(requirementSuggestion);
    const blueprintSuggestion = pendingBody(blueprint.id, data.blueprint.body);
    store.saveSuggestion(blueprintSuggestion);

    return {
      requirementId: requirement.id,
      blueprintId: blueprint.id,
      artifactIds,
      requirementSuggestionId: requirementSuggestion.id,
      blueprintSuggestionId: blueprintSuggestion.id,
    };
  } catch (err) {
    for (const id of created.reverse()) {
      try {
        store.deleteEntity(id);
      } catch {
        // best-effort compensation; the original error is what matters
      }
    }
    throw err;
  }
}
