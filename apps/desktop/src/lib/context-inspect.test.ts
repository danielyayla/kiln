import { describe, expect, it } from "vitest";
import type { Entity, HealthCheck, WorkOrderContext } from "@kiln/core";
import {
  BACKGROUND_DIVIDER,
  contextDocs,
  contextVerdict,
  docChars,
  mapCheckTarget,
  mergeReceiptTimeline,
  renderContextText,
  sectionDrift,
  totalChars,
} from "./context-inspect";

const entity = (id: string, type: Entity["type"], title: string, body = "body"): Entity => ({
  id,
  type,
  title,
  body,
  status: null,
  assignee: null,
  createdAt: "2026-07-11T00:00:00.000Z",
  updatedAt: "2026-07-11T00:00:00.000Z",
});

const full: WorkOrderContext = {
  workOrder: entity("w1", "work_order", "Ship it", "do `thing`"),
  blueprint: entity("b1", "blueprint", "BP", "design"),
  requirement: entity("r1", "requirement", "Req", "intent"),
  artifacts: [entity("a1", "artifact", "Notes", "notes body")],
  lineage: [
    {
      requirement: entity("pr1", "requirement", "Parent"),
      blueprint: entity("pb1", "blueprint", "Parent arch"),
      artifacts: [entity("pa1", "artifact", "Parent notes")],
    },
    { requirement: entity("root1", "requirement", "Root"), artifacts: [] },
  ],
};

const check = (code: string, message = "", level: HealthCheck["level"] = "warn"): HealthCheck => ({ code, message, level });

describe("contextDocs", () => {
  it("flattens every document in serialization order, including lineage blueprints", () => {
    const docs = contextDocs(full);
    expect(docs.map((d) => d.key)).toEqual([
      "doc-wo-w1",
      "doc-bp-b1",
      "doc-req-r1",
      "doc-art-a1",
      "doc-lin-req-pr1",
      "doc-lin-bp-pb1",
      "doc-lin-art-pa1",
      "doc-lin-req-root1",
    ]);
    expect(docs.find((d) => d.key === "doc-lin-bp-pb1")?.via).toBe("Parent");
    expect(docs.find((d) => d.key === "doc-lin-art-pa1")?.via).toBe("Parent");
  });

  it("tiers docs: chain=1, artifacts and nearer lineage=2, outermost lineage=3", () => {
    const byKey = new Map(contextDocs(full).map((d) => [d.key, d.tier]));
    expect(byKey.get("doc-wo-w1")).toBe(1);
    expect(byKey.get("doc-bp-b1")).toBe(1);
    expect(byKey.get("doc-req-r1")).toBe(1);
    expect(byKey.get("doc-art-a1")).toBe(2);
    expect(byKey.get("doc-lin-req-pr1")).toBe(2);
    expect(byKey.get("doc-lin-bp-pb1")).toBe(2);
    expect(byKey.get("doc-lin-art-pa1")).toBe(2);
    expect(byKey.get("doc-lin-req-root1")).toBe(3);
    // Tiers are monotonic — the doc list is already in reading order.
    const tiers = contextDocs(full).map((d) => d.tier);
    expect([...tiers].sort((a, b) => a - b)).toEqual(tiers);
  });

  it("makes the sole lineage entry tier 3 (a WO directly under the root)", () => {
    const direct: WorkOrderContext = { ...full, lineage: [full.lineage[1]] };
    expect(contextDocs(direct).find((d) => d.key === "doc-lin-req-root1")?.tier).toBe(3);
  });

  it("omits missing chain links and per-doc sizes sum to the total", () => {
    const bare: WorkOrderContext = { ...full, blueprint: null, requirement: null, artifacts: [], lineage: [] };
    const docs = contextDocs(bare);
    expect(docs.map((d) => d.key)).toEqual(["doc-wo-w1"]);
    expect(totalChars(docs)).toBe(docChars(bare.workOrder));
  });
});

describe("renderContextText", () => {
  it("keeps missing chain links visible as em-dash sections", () => {
    const bare: WorkOrderContext = { ...full, blueprint: null, requirement: null };
    const text = renderContextText(bare);
    expect(text).toContain("## Blueprint: —");
    expect(text).toContain("## Requirement: —");
    // Order: work order, blueprint placeholder, requirement placeholder, artifacts.
    expect(text.indexOf("## Work order")).toBeLessThan(text.indexOf("## Blueprint: —"));
    expect(text.indexOf("## Blueprint: —")).toBeLessThan(text.indexOf("## Requirement: —"));
    expect(text.indexOf("## Requirement: —")).toBeLessThan(text.indexOf("## Artifact: Notes"));
  });

  it("serializes lineage blueprints (Phase 14) alongside their requirement", () => {
    const text = renderContextText(full);
    expect(text).toContain("## Inherited blueprint: Parent arch");
    expect(text.indexOf("## Ancestor requirement: Parent")).toBeLessThan(text.indexOf("## Inherited blueprint: Parent arch"));
  });

  it("is deterministic for identical contexts", () => {
    expect(renderContextText(full)).toBe(renderContextText(structuredClone(full)));
  });

  it("emits the background divider once, before the outermost lineage entry only", () => {
    const text = renderContextText(full);
    expect(text.split(BACKGROUND_DIVIDER)).toHaveLength(2);
    // Nearer lineage stays above the divider; the root goes below it.
    expect(text.indexOf("## Ancestor requirement: Parent")).toBeLessThan(text.indexOf(BACKGROUND_DIVIDER));
    expect(text.indexOf(BACKGROUND_DIVIDER)).toBeLessThan(text.indexOf("## Ancestor requirement: Root"));
    expect(text.trimEnd().endsWith("## Ancestor requirement: Root\nbody")).toBe(true);
  });

  it("renders flat stores byte-identically to the pre-divider format", () => {
    const flat: WorkOrderContext = { ...full, lineage: [] };
    const text = renderContextText(flat);
    expect(text).not.toContain(BACKGROUND_DIVIDER);
    expect(text).toBe(
      [
        "## Work order: Ship it\ndo `thing`",
        "## Blueprint: BP\ndesign",
        "## Requirement: Req\nintent",
        "## Artifact: Notes\nnotes body",
      ].join("\n\n"),
    );
  });
});

describe("mapCheckTarget", () => {
  it("points missing chain links at their section", () => {
    expect(mapCheckTarget(check("missing-blueprint"), full)).toBe("sec-blueprint");
    expect(mapCheckTarget(check("missing-requirement"), full)).toBe("sec-requirement");
  });

  it("finds the empty artifact by its quoted title, wherever it lives", () => {
    expect(mapCheckTarget(check("empty-artifact", 'Artifact "Notes" is referenced but has an empty body.'), full)).toBe(
      "doc-art-a1",
    );
    expect(
      mapCheckTarget(check("empty-artifact", 'Artifact "Parent notes" is referenced but has an empty body.'), full),
    ).toBe("doc-lin-art-pa1");
    // Unmatchable title falls back to the artifacts section rather than nothing.
    expect(mapCheckTarget(check("empty-artifact", 'Artifact "gone" …'), full)).toBe("sec-artifacts");
  });

  it("points root-context checks at the outermost lineage requirement", () => {
    expect(mapCheckTarget(check("empty-root-body", 'Root requirement "Root" …'), full)).toBe("doc-lin-req-root1");
    expect(mapCheckTarget(check("missing-architecture", 'Root requirement "Root" …'), full)).toBe("doc-lin-req-root1");
    expect(mapCheckTarget(check("empty-root-body"), { ...full, lineage: [] })).toBeNull();
  });

  it("points background-heavy at the first lineage document", () => {
    expect(mapCheckTarget(check("background-heavy"), full)).toBe("doc-lin-req-pr1");
    expect(mapCheckTarget(check("background-heavy"), { ...full, lineage: [] })).toBe("sec-lineage");
  });

  it("points size checks at the largest document", () => {
    const heavy: WorkOrderContext = {
      ...full,
      artifacts: [entity("a2", "artifact", "Huge", "x".repeat(500))],
      lineage: [],
    };
    expect(mapCheckTarget(check("oversized"), heavy)).toBe("doc-art-a2");
    expect(mapCheckTarget(check("low-signal"), heavy)).toBe("doc-art-a2");
  });

  it("leaves informational codes unmapped", () => {
    for (const code of ["no-artifacts", "inherited-lineage", "no-root-context", "ungrounded-reference"]) {
      expect(mapCheckTarget(check(code), full)).toBeNull();
    }
  });
});

describe("sectionDrift", () => {
  it("reads all-unchanged for identical contexts", () => {
    const drift = sectionDrift(full, structuredClone(full));
    expect(drift).toHaveLength(contextDocs(full).length);
    expect(drift.every((d) => d.kind === "unchanged")).toBe(true);
  });

  it("marks an edited body as changed, keyed by the same entity", () => {
    const edited = structuredClone(full);
    edited.blueprint = { ...edited.blueprint!, body: "revised design" };
    const drift = sectionDrift(full, edited);
    expect(drift.find((d) => d.key === "doc-bp-b1")?.kind).toBe("changed");
    expect(drift.filter((d) => d.kind !== "unchanged")).toHaveLength(1);
  });

  it("marks appearing/disappearing documents as added/removed", () => {
    const later = structuredClone(full);
    later.artifacts = [...later.artifacts, entity("a9", "artifact", "New sketch")];
    later.lineage = []; // inherited context dropped since the receipt
    const drift = sectionDrift(full, later);
    expect(drift.find((d) => d.key === "doc-art-a9")?.kind).toBe("added");
    for (const key of ["doc-lin-req-pr1", "doc-lin-bp-pb1", "doc-lin-art-pa1", "doc-lin-req-root1"]) {
      expect(drift.find((d) => d.key === key)?.kind).toBe("removed");
    }
  });

  it("reads a swapped entity as removed + added, not changed", () => {
    const swapped = structuredClone(full);
    swapped.blueprint = entity("b2", "blueprint", "Other BP", "design");
    const drift = sectionDrift(full, swapped);
    expect(drift.find((d) => d.key === "doc-bp-b1")?.kind).toBe("removed");
    expect(drift.find((d) => d.key === "doc-bp-b2")?.kind).toBe("added");
  });
});

describe("contextVerdict", () => {
  it("reads ready when only info checks are present", () => {
    expect(contextVerdict([check("inherited-lineage", "", "info")])).toEqual({ ready: true, errors: 0, warnings: 0 });
  });
  it("counts warnings and errors", () => {
    expect(contextVerdict([check("a", "", "warn"), check("b", "", "warn"), check("c", "", "error")])).toEqual({
      ready: false,
      errors: 1,
      warnings: 2,
    });
  });
});

describe("mergeReceiptTimeline", () => {
  const at = (id: string, createdAt: string) => ({ id, createdAt });

  it("returns nothing when both sides are empty", () => {
    expect(mergeReceiptTimeline([], [])).toEqual([]);
  });

  it("interleaves deliveries and returns newest-first", () => {
    const rows = mergeReceiptTimeline(
      [at("d1", "2026-07-21T09:00:00.000Z"), at("d2", "2026-07-21T11:00:00.000Z")],
      [at("c1", "2026-07-21T10:00:00.000Z")],
    );
    expect(rows.map((r) => [r.kind, r.receipt.id])).toEqual([
      ["delivered", "d2"],
      ["returned", "c1"],
      ["delivered", "d1"],
    ]);
  });

  it("puts a same-instant return above the delivery it answers, then ties by id", () => {
    const instant = "2026-07-21T10:00:00.000Z";
    const rows = mergeReceiptTimeline([at("d1", instant)], [at("c1", instant)]);
    expect(rows.map((r) => r.kind)).toEqual(["returned", "delivered"]);

    const sameKind = mergeReceiptTimeline([at("d2", instant), at("d1", instant)], []);
    expect(sameKind.map((r) => r.receipt.id)).toEqual(["d1", "d2"]);
  });
});
