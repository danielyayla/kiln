import type { Entity, HealthCheck, WorkOrderContext } from "@kiln/core";

// Pure logic behind the Context Inspector (BP-17): the flattened document
// list the pre-flight view renders and sizes, the stable serialization the
// forensic diff compares, and the check → document mapping that makes health
// checks clickable. No DOM here — the component owns ids and scrolling.

// Section keys exist even when the document is missing (a "missing-blueprint"
// check must still have somewhere to point).
export type TargetKey =
  | "sec-workOrder"
  | "sec-blueprint"
  | "sec-requirement"
  | "sec-artifacts"
  | "sec-lineage"
  | `doc-${string}`;

export interface ContextDoc {
  /** Stable key, unique within one context: `doc-<role>-<entityId>`. */
  key: `doc-${string}`;
  label: string;
  entity: Entity;
  section: "workOrder" | "blueprint" | "requirement" | "artifacts" | "lineage";
  chars: number;
  /** Lineage docs: the ancestor requirement they were inherited through. */
  via?: string;
  /**
   * Reading priority (authoring methodology): 1 = actionable (work order,
   * blueprint, requirement), 2 = situational (artifacts, nearer lineage),
   * 3 = background — the OUTERMOST lineage entry (product root material).
   */
  tier: 1 | 2 | 3;
}

// Mirrors core's entityChars so per-doc sizes sum to the health report's total.
export const docChars = (e: Entity): number => e.title.length + e.body.length;

// Every document in an assembled context, in the order the agent-facing
// serialization presents them. Includes lineage blueprints (Phase 14) — the
// pre-Phase-17 inspector silently dropped those.
export function contextDocs(ctx: WorkOrderContext): ContextDoc[] {
  const doc = (
    role: string,
    label: string,
    entity: Entity,
    section: ContextDoc["section"],
    tier: ContextDoc["tier"],
    via?: string,
  ): ContextDoc => ({ key: `doc-${role}-${entity.id}`, label, entity, section, chars: docChars(entity), via, tier });

  return [
    doc("wo", "Work order", ctx.workOrder, "workOrder", 1),
    ...(ctx.blueprint ? [doc("bp", "Blueprint", ctx.blueprint, "blueprint", 1)] : []),
    ...(ctx.requirement ? [doc("req", "Requirement", ctx.requirement, "requirement", 1)] : []),
    ...ctx.artifacts.map((a) => doc("art", "Artifact", a, "artifacts", 2)),
    ...ctx.lineage.flatMap((l, i) => {
      // The outermost entry is the tree root — product overview + architecture
      // in a store with a product root. Background, not instructions.
      const tier = i === ctx.lineage.length - 1 ? 3 : 2;
      return [
        doc("lin-req", "Ancestor requirement", l.requirement, "lineage", tier),
        ...(l.blueprint ? [doc("lin-bp", "Inherited blueprint", l.blueprint, "lineage", tier, l.requirement.title)] : []),
        ...l.artifacts.map((a) => doc("lin-art", "Inherited artifact", a, "lineage", tier, l.requirement.title)),
      ];
    }),
  ];
}

export const totalChars = (docs: ContextDoc[]): number => docs.reduce((n, d) => n + d.chars, 0);

// A stable, human-readable serialization of an assembled context — what the
// copy button exports and what the forensic diff compares. Any change (edited
// body, added/removed document) shows as line inserts/deletes.
// Marks where tier-3 material starts in the linear serialization. The exact
// string matters: it is part of Copy-context output and of the forensic diff
// baseline once both sides render with it.
export const BACKGROUND_DIVIDER = "--- Background context (skim; never overrides the work order) ---";

export function renderContextText(ctx: WorkOrderContext): string {
  const missing = (label: string) => `## ${label}: —`;
  const render = (d: ContextDoc) => `## ${d.label}: ${d.entity.title}\n${d.entity.body}`;
  const docs = contextDocs(ctx);
  const sections = docs.filter((d) => d.tier < 3).map(render);
  // Missing chain links stay visible in the serialization so their appearance
  // later diffs as an insert, not silence.
  if (!ctx.blueprint) sections.splice(1, 0, missing("Blueprint"));
  if (!ctx.requirement) sections.splice(2, 0, missing("Requirement"));
  // Tier-3 (the outermost lineage entry) renders last, behind a divider; a
  // flat store has no tier-3 docs and its output is byte-identical.
  const background = docs.filter((d) => d.tier === 3).map(render);
  if (background.length > 0) sections.push(BACKGROUND_DIVIDER, ...background);
  return sections.join("\n\n");
}

// Where a health check should take the user (BP-17 mapping). Null = purely
// informational, renders as plain text.
export function mapCheckTarget(check: HealthCheck, ctx: WorkOrderContext): TargetKey | null {
  const docs = contextDocs(ctx);
  const quoted = (title: string) => check.message.includes(`"${title}"`);

  switch (check.code) {
    case "missing-blueprint":
      return "sec-blueprint";
    case "missing-requirement":
      return "sec-requirement";
    case "empty-artifact": {
      const hit = docs.find((d) => (d.key.startsWith("doc-art-") || d.key.startsWith("doc-lin-art-")) && quoted(d.entity.title));
      return hit ? hit.key : "sec-artifacts";
    }
    case "empty-root-body":
    case "missing-architecture": {
      // Both judge the OUTERMOST lineage entry (the tree root); when they
      // fire, the problem lives on (or is missing from) the root requirement.
      const root = ctx.lineage[ctx.lineage.length - 1];
      return root ? `doc-lin-req-${root.requirement.id}` : null;
    }
    case "background-heavy": {
      // The weight lives in the lineage; jump to its first document.
      const first = docs.find((d) => d.section === "lineage");
      return first ? first.key : "sec-lineage";
    }
    case "oversized":
    case "low-signal": {
      const largest = [...docs].sort((a, b) => b.chars - a.chars)[0];
      return largest ? largest.key : null;
    }
    default:
      return null;
  }
}

// Section-by-section drift between two assembled contexts (BP-17 forensic
// summary). Documents are keyed by role + entity id (contextDocs keys), so an
// edited body reads "changed" while a swapped entity reads removed + added.
export type DriftKind = "added" | "removed" | "changed" | "unchanged";
export interface SectionDrift {
  key: `doc-${string}`;
  label: string;
  title: string;
  kind: DriftKind;
}

export function sectionDrift(a: WorkOrderContext, b: WorkOrderContext): SectionDrift[] {
  const aDocs = new Map(contextDocs(a).map((d) => [d.key, d]));
  const drift: SectionDrift[] = [];
  for (const d of contextDocs(b)) {
    const prev = aDocs.get(d.key);
    aDocs.delete(d.key);
    const kind: DriftKind = !prev
      ? "added"
      : prev.entity.title !== d.entity.title || prev.entity.body !== d.entity.body
        ? "changed"
        : "unchanged";
    drift.push({ key: d.key, label: d.label, title: d.entity.title, kind });
  }
  // Whatever wasn't matched existed only in `a`.
  for (const d of aDocs.values()) drift.push({ key: d.key, label: d.label, title: d.entity.title, kind: "removed" });
  return drift;
}

// The receipts tab's merged handoff loop: deliveries (context receipts) and
// returns (completion receipts) in one newest-first timeline. Same-instant
// ties read reverse-chronologically — the return sits above the delivery it
// answers — then break by id so reruns are stable.
export type ReceiptTimelineRow<D, R> =
  | { kind: "delivered"; at: string; receipt: D }
  | { kind: "returned"; at: string; receipt: R };

export function mergeReceiptTimeline<
  D extends { id: string; createdAt: string },
  R extends { id: string; createdAt: string },
>(delivered: D[], returned: R[]): ReceiptTimelineRow<D, R>[] {
  const rows: ReceiptTimelineRow<D, R>[] = [
    ...delivered.map((r) => ({ kind: "delivered" as const, at: r.createdAt, receipt: r })),
    ...returned.map((r) => ({ kind: "returned" as const, at: r.createdAt, receipt: r })),
  ];
  return rows.sort(
    (a, b) =>
      b.at.localeCompare(a.at) ||
      (a.kind === b.kind ? a.receipt.id.localeCompare(b.receipt.id) : a.kind === "returned" ? -1 : 1),
  );
}

// The verdict the banner renders: info-level checks alone still read as ready.
export function contextVerdict(checks: HealthCheck[]): { ready: boolean; errors: number; warnings: number } {
  const errors = checks.filter((c) => c.level === "error").length;
  const warnings = checks.filter((c) => c.level === "warn").length;
  return { ready: errors === 0 && warnings === 0, errors, warnings };
}
