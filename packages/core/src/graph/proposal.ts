import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Entity, Id, Suggestion } from "../domain";
import { ConstraintError, NotFoundError } from "../errors";
import { DESIGN_DOC_TEMPLATE } from "../seed";
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

// The survey's root documents: the product overview proposed for the product
// root requirement's body, and the system-architecture summary proposed for
// the root's `details` blueprint. Evidence is optional here — the per-feature
// proposals carry the mandatory evidence; the root documents are a synthesis
// of them.
export const ProposedRootOverview = z.object({
  overview: nonBlank("overview"),
  architecture: nonBlank("architecture"),
  evidence: z.array(proposedDocument("evidence")).default([]),
});
export type ProposedRootOverview = z.input<typeof ProposedRootOverview>;

export interface ProposedRootOverviewIds {
  rootRequirementId: Id;
  blueprintId: Id;
  artifactIds: Id[];
  overviewSuggestionId: Id;
  architectureSuggestionId: Id;
}

// A fresh project's root requirement is seeded empty, but its design-doc
// blueprint is seeded with the fill-in DESIGN_DOC_TEMPLATE — so a proposal
// appends to an empty body and REPLACES a template body (whole-body anchor:
// unique by construction, and acceptance swaps template for proposal).
const pendingBodyFor = (target: Entity, text: string): Suggestion => ({
  id: randomUUID(),
  targetId: target.id,
  source: "extract_agent",
  ops:
    target.body.trim() === ""
      ? [{ kind: "insert", anchor: "", text }]
      : [{ kind: "replace", anchor: target.body, text }],
});

// A root document is proposable only while PRISTINE — untouched since project
// seeding. Anything else means a human (or an accepted earlier proposal)
// already owns the body, and v1 has no merge semantics: refuse loudly.
const pristine = (entity: Entity) =>
  entity.body.trim() === "" || entity.body === DESIGN_DOC_TEMPLATE;

// Materialize the surveyed root overview behind the suggestion gate: nothing
// is committed — the overview lands as a pending suggestion on the product
// root requirement and the architecture summary as one on the root's
// `details` blueprint. Optional evidence artifacts get their bodies directly
// (read-only source material) and are `references`-linked from the root.
//
// Validate-then-write, same as proposeFeature: every rejection happens before
// the first store call; an unexpected mid-write failure is compensated by
// deleting the saved suggestions and created artifacts.
export function proposeRootOverview(
  store: Store,
  rootRequirementId: Id,
  proposal: ProposedRootOverview,
): ProposedRootOverviewIds {
  const parsed = ProposedRootOverview.safeParse(proposal);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ConstraintError(`invalid root-overview proposal: ${issues}`);
  }
  const data = parsed.data;

  const root = store.getEntity(rootRequirementId);
  if (!root) throw new NotFoundError(rootRequirementId);
  if (root.type !== "requirement") {
    throw new ConstraintError(
      `root-overview target ${rootRequirementId} is a ${root.type}, not a requirement`,
    );
  }
  if (store.linked(root.id, "child_of").length > 0) {
    throw new ConstraintError(
      `requirement ${rootRequirementId} has a parent — the root overview lands only on the parentless product root`,
    );
  }
  const blueprints = store.linkedFrom(root.id, "details").filter((e) => e.type === "blueprint");
  if (blueprints.length === 0) {
    throw new ConstraintError(
      `product root ${rootRequirementId} has no details blueprint to receive the architecture summary`,
    );
  }
  if (blueprints.length > 1) {
    throw new ConstraintError(
      `product root ${rootRequirementId} has ${blueprints.length} details blueprints — ambiguous architecture target`,
    );
  }
  const blueprint = blueprints[0];

  if (!pristine(root)) {
    throw new ConstraintError(
      `product root "${root.title}" already has a non-empty body — v1 proposes the overview only into a pristine root`,
    );
  }
  if (!pristine(blueprint)) {
    throw new ConstraintError(
      `architecture blueprint "${blueprint.title}" has been edited since seeding — v1 proposes only over the pristine template`,
    );
  }
  for (const target of [root, blueprint]) {
    const pending = store.listSuggestions(target.id).length;
    if (pending > 0) {
      throw new ConstraintError(
        `${target.type} ${target.id} has ${pending} pending suggestion(s); resolve or dismiss them before proposing`,
      );
    }
  }

  const createdArtifacts: Id[] = [];
  const savedSuggestions: Id[] = [];
  try {
    const artifactIds: Id[] = [];
    for (const evidence of data.evidence) {
      const artifact = store.createEntity({
        type: "artifact",
        title: evidence.title,
        body: evidence.body,
      });
      createdArtifacts.push(artifact.id);
      store.link(root.id, artifact.id, "references");
      artifactIds.push(artifact.id);
    }

    const overviewSuggestion = pendingBodyFor(root, data.overview);
    store.saveSuggestion(overviewSuggestion);
    savedSuggestions.push(overviewSuggestion.id);
    const architectureSuggestion = pendingBodyFor(blueprint, data.architecture);
    store.saveSuggestion(architectureSuggestion);
    savedSuggestions.push(architectureSuggestion.id);

    return {
      rootRequirementId: root.id,
      blueprintId: blueprint.id,
      artifactIds,
      overviewSuggestionId: overviewSuggestion.id,
      architectureSuggestionId: architectureSuggestion.id,
    };
  } catch (err) {
    for (const id of savedSuggestions.reverse()) {
      try {
        store.deleteSuggestion(id);
      } catch {
        // best-effort compensation; the original error is what matters
      }
    }
    for (const id of createdArtifacts.reverse()) {
      try {
        store.deleteEntity(id);
      } catch {
        // best-effort compensation; the original error is what matters
      }
    }
    throw err;
  }
}
