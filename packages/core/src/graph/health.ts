import type { Entity } from "../domain";
import type { WorkOrderContext } from "./context";

// Deterministic, model-free structural checks over an assembled context
// (Phase 8 — pre-flight verification). Answers "is this context complete,
// well-scoped, and grounded?" before an agent is handed it.

export type HealthLevel = "info" | "warn" | "error";
export interface HealthCheck {
  level: HealthLevel;
  code: string;
  message: string;
}
export interface ContextHealth {
  size: { chars: number; estTokens: number };
  checks: HealthCheck[];
}

// A large context risks burying the signal; a rough budget in tokens (~4 chars).
const OVERSIZED_TOKENS = 8000;
// Artifacts dwarfing the spec by this factor is a noise smell (the WO-C1 case).
const LOW_SIGNAL_RATIO = 5;
// Inherited (lineage) material dwarfing the actionable tier — the work order's
// own chain — by this factor means the agent reads mostly background.
const BACKGROUND_RATIO = 3;
// Below this much background the ratio is noise, not signal (tiny contexts).
const BACKGROUND_MIN_CHARS = 2000;

const entityChars = (e: Entity | null): number => (e ? e.title.length + e.body.length : 0);

export function contextHealth(ctx: WorkOrderContext): ContextHealth {
  const { workOrder, blueprint, requirement, artifacts, lineage } = ctx;
  const inheritedArtifacts = lineage.flatMap((l) => l.artifacts);
  const allArtifacts = [...artifacts, ...inheritedArtifacts];

  const woChars = entityChars(workOrder);
  const reqChars = entityChars(requirement);
  const artifactChars = allArtifacts.reduce((n, a) => n + entityChars(a), 0);
  const lineageChars = lineage.reduce((n, l) => n + entityChars(l.requirement) + entityChars(l.blueprint ?? null), 0);
  const chars = woChars + reqChars + entityChars(blueprint) + artifactChars + lineageChars;
  const estTokens = Math.ceil(chars / 4);

  const checks: HealthCheck[] = [];
  const add = (level: HealthLevel, code: string, message: string) => checks.push({ level, code, message });

  if (!blueprint) add("warn", "missing-blueprint", "No blueprint — the agent has no design to implement against.");
  if (!requirement) add("warn", "missing-requirement", "No requirement — the agent has no stated intent behind the work.");
  if (allArtifacts.length === 0) add("info", "no-artifacts", "No source artifacts in the context.");

  for (const a of allArtifacts) {
    if (a.body.trim() === "") add("warn", "empty-artifact", `Artifact "${a.title}" is referenced but has an empty body.`);
  }

  if (estTokens > OVERSIZED_TOKENS)
    add("warn", "oversized", `Context is large (~${estTokens} tokens) — the agent may lose the signal.`);

  const specChars = woChars + reqChars;
  if (artifactChars > 0 && specChars > 0 && artifactChars > LOW_SIGNAL_RATIO * specChars)
    add(
      "info",
      "low-signal",
      `Artifacts are ~${Math.round(artifactChars / specChars)}× the size of the spec — much of the context may be irrelevant to this work order.`,
    );

  // Tier share (authoring methodology): lineage material — ancestor
  // requirements, their blueprints, inherited artifacts — vs the actionable
  // tier (work order + blueprint + requirement + own artifacts). Never a
  // reason to trim; a signal that the handoff is mostly background.
  const inheritedChars = inheritedArtifacts.reduce((n, a) => n + entityChars(a), 0);
  const backgroundChars = lineageChars + inheritedChars;
  const actionableChars = chars - backgroundChars;
  if (
    backgroundChars >= BACKGROUND_MIN_CHARS &&
    actionableChars > 0 &&
    backgroundChars > BACKGROUND_RATIO * actionableChars
  )
    add(
      "warn",
      "background-heavy",
      `Inherited background is ~${Math.round(backgroundChars / actionableChars)}× the actionable context — the agent will read mostly ancestor material.`,
    );

  add(
    "info",
    "inherited-lineage",
    lineage.length === 0
      ? "No inherited context (top-level requirement)."
      : `Inherited ${lineage.length} ancestor requirement(s) and ${inheritedArtifacts.length} artifact(s) from up the tree.`,
  );

  // Root context (Phase 14): does inherited intent reach a root, and does that
  // root actually carry a product overview and an architecture blueprint? The
  // outermost lineage entry (last, in nearest-first order) is the tree root.
  if (lineage.length === 0) {
    add("info", "no-root-context", "No inherited root context — the work order sees only its own requirement.");
  } else {
    const root = lineage[lineage.length - 1];
    if (root.requirement.body.trim() === "")
      add(
        "warn",
        "empty-root-body",
        `Root requirement "${root.requirement.title}" has an empty body — no product overview reaches this handoff.`,
      );
    if (!root.blueprint)
      add(
        "warn",
        "missing-architecture",
        `Root requirement "${root.requirement.title}" has no details blueprint — no architecture overview reaches this handoff.`,
      );
  }

  // Ungrounded references: backticked identifiers in the work-order body that
  // appear nowhere in the SUPPORTING context (they may live in the codebase).
  const support = [blueprint, requirement, ...allArtifacts, ...lineage.flatMap((l) => [l.requirement, l.blueprint ?? null])]
    .filter((e): e is Entity => e !== null)
    .map((e) => `${e.title} ${e.body}`)
    .join(" ");
  const refs = [...new Set([...workOrder.body.matchAll(/`([^`]+)`/g)].map((m) => m[1]))];
  const ungrounded = refs.filter((r) => !support.includes(r));
  if (ungrounded.length > 0)
    add(
      "info",
      "ungrounded-reference",
      `${ungrounded.length} backticked reference(s) in the work order are not defined anywhere in the context: ${ungrounded.map((r) => `\`${r}\``).join(", ")}.`,
    );

  return { size: { chars, estTokens }, checks };
}
