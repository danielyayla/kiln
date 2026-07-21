import type { Id } from "../domain";
import { effectiveWorkType } from "../domain";
import { NotFoundError } from "../errors";
import type { Store } from "../store";
import { driftChecks } from "./drift";
import type { HealthCheck } from "./health";
import { productRoot, rootRequirements } from "./roots";
import { workTypeFromTitle } from "./work-type";

// Layer 2 of the authoring-methodology enforcement ladder: deterministic
// per-document checks for a single requirement / blueprint / work order /
// artifact. Reports, never blocks — the draft→ready gate is a later layer.
// (The assembled-context view of health is contextHealth; this is the
// document's own shape and links.)

export interface DocumentHealth {
  checks: HealthCheck[];
}

// Template headings are canonical (docs/authoring-methodology.md); enforcing
// the shape is the point of an opinionated standard.
const hasHeading = (body: string, title: string) => new RegExp(`^#{1,6}\\s*${title}\\b`, "im").test(body);

export function documentHealth(store: Store, id: Id): DocumentHealth {
  const entity = store.getEntity(id);
  if (!entity) throw new NotFoundError(id);

  const checks: HealthCheck[] = [];
  const add = (level: HealthCheck["level"], code: string, message: string) => checks.push({ level, code, message });

  // Traceability first — link problems degrade assembled contexts for real.
  if (entity.type === "work_order") {
    const targets = store.linked(entity.id, "implements");
    if (targets.length === 0) {
      add("warn", "missing-implements", "No implements link — this work order will assemble an empty context.");
    } else {
      for (const t of targets.filter((t) => t.type !== "blueprint")) {
        add(
          "error",
          "implements-not-blueprint",
          `implements target "${t.title}" is a ${t.type}, not a blueprint — context assembly resolves work order → blueprint → requirement, so this work order assembles a degraded context (no requirement, no lineage).`,
        );
      }
    }
  }

  if (entity.type === "blueprint") {
    // Detailing MORE than one requirement needs no check here — the Store
    // rejects a second details link at write time (1:1 constraint).
    if (store.linked(entity.id, "details").length === 0)
      add("warn", "missing-details", "No details link — this blueprint is anchored to no requirement.");
  }

  if (entity.type === "requirement" && store.linked(entity.id, "child_of").length === 0) {
    // A second parentless requirement silently dissolves the product-root
    // convention (the Phase-15 bug). Warn when another parentless requirement
    // already anchors a tree; a genuinely flat store stays quiet.
    const otherTreeRoot = rootRequirements(store)
      .filter((r) => r.id !== entity.id)
      .some((r) => store.linkedFrom(r.id, "child_of").some((c) => c.type === "requirement"));
    if (otherTreeRoot)
      add(
        "warn",
        "detached-requirement",
        "Parentless requirement in a store with a product tree — it dissolves the product-root convention; link it child_of a parent.",
      );
  }

  if (entity.type === "requirement") {
    // Methodology §1 title rule for FEATURES (direct children of the product
    // root): `<Name> — <plain-language description>`. The root itself, nested
    // sub-requirements, and flat stores are exempt — style, never the gate.
    const parent = store.linked(entity.id, "child_of")[0];
    const root = parent ? productRoot(store) : null;
    if (parent && root && parent.id === root.id) {
      const m = /^.+ — (.*)$/u.exec(entity.title);
      if (!m || m[1].trim() === "")
        add(
          "info",
          "feature-title-shape",
          'Feature title doesn\'t follow `<Name> — <plain-language description>` — a navigator reader should learn what the feature does from the title alone (methodology §1).',
        );
    }
  }

  // Template shape — reported softly so legacy documents inform, not scream.
  if (entity.body.trim() === "") add("warn", "empty-body", "The document body is empty.");

  if (entity.type === "work_order" && entity.body.trim() !== "") {
    if (!hasHeading(entity.body, "Acceptance criteria") && !entity.body.includes("- [ ]"))
      add(
        "warn",
        "missing-acceptance-criteria",
        "No acceptance criteria — an agent cannot tell when this work order is done.",
      );
    if (!hasHeading(entity.body, "Out of scope"))
      add("info", "missing-out-of-scope", "No Out-of-scope section — eager agents widen scope without one.");
  }

  if (entity.type === "requirement" && entity.body.trim() !== "" && !hasHeading(entity.body, "Non-goals"))
    add("info", "missing-non-goals", "No Non-goals section — every feature has adjacent scope it should decline.");

  if (entity.type === "work_order") {
    // The field is the source of truth (BP-18); a `[bug]`-style title prefix
    // that says otherwise misleads every reader who trusts the title.
    const prefix = workTypeFromTitle(entity.title);
    const effective = effectiveWorkType(entity);
    if (prefix !== null && prefix !== effective)
      add(
        "info",
        "work-type-prefix-mismatch",
        `Title prefix [${prefix}] disagrees with the work type "${effective}" — set workType to ${prefix} or fix the title; the field is what context assembly and the Board trust.`,
      );
  }

  checks.push(...driftChecks(store, entity));

  return { checks };
}
