import { describe, expect, it } from "vitest";
import type { Entity } from "../domain";
import type { WorkOrderContext } from "./context";
import { contextHealth } from "./health";
import { workTypeGuidance } from "./work-type";

const ent = (over: Partial<Entity>): Entity => ({
  id: "id",
  type: "work_order",
  title: "T",
  body: "",
  status: null,
  workType: null,
  criticality: null,
  assignee: null,
  createdAt: "t",
  updatedAt: "t",
  ...over,
});

// A healthy baseline context; override pieces per test.
const ctx = (over: Partial<WorkOrderContext> = {}): WorkOrderContext => ({
  workOrder: ent({ type: "work_order", title: "WO", body: "do it" }),
  workType: "feature",
  guidance: workTypeGuidance("feature"),
  blueprint: ent({ type: "blueprint", title: "BP", body: "the approach" }),
  requirement: ent({ type: "requirement", title: "REQ", body: "the intent" }),
  artifacts: [],
  lineage: [],
  ...over,
});

const codes = (c: WorkOrderContext) => contextHealth(c).checks.map((k) => k.code);

describe("contextHealth — size", () => {
  it("counts characters across the bundle and estimates tokens at ~4 chars", () => {
    const only = ctx({ blueprint: null, requirement: null, workOrder: ent({ title: "T", body: "abcd" }) });
    const { size } = contextHealth(only);
    expect(size.chars).toBe(5); // "T" + "abcd"
    expect(size.estTokens).toBe(2); // ceil(5/4)
  });
});

describe("contextHealth — structural checks", () => {
  it("flags a missing blueprint and missing requirement, and not when present", () => {
    expect(codes(ctx({ blueprint: null }))).toContain("missing-blueprint");
    expect(codes(ctx({ requirement: null }))).toContain("missing-requirement");
    expect(codes(ctx())).not.toContain("missing-blueprint");
    expect(codes(ctx())).not.toContain("missing-requirement");
  });

  it("flags no artifacts, and not when an artifact is present", () => {
    expect(codes(ctx())).toContain("no-artifacts");
    expect(codes(ctx({ artifacts: [ent({ type: "artifact", body: "src" })] }))).not.toContain("no-artifacts");
  });

  it("flags an empty artifact body", () => {
    const withEmpty = ctx({ artifacts: [ent({ type: "artifact", title: "Notes", body: "   " })] });
    expect(codes(withEmpty)).toContain("empty-artifact");
    expect(codes(ctx({ artifacts: [ent({ type: "artifact", body: "real" })] }))).not.toContain("empty-artifact");
  });

  it("flags an oversized context over the token budget", () => {
    const big = ctx({ artifacts: [ent({ type: "artifact", body: "x".repeat(40_000) })] });
    expect(codes(big)).toContain("oversized");
    expect(codes(ctx())).not.toContain("oversized");
  });

  it("flags background-heavy lineage, but never for flat or light contexts", () => {
    const lineageEntry = (body: string) => ({
      requirement: ent({ type: "requirement" as const, title: "Root", body }),
      artifacts: [],
    });
    // Flat store: no lineage, never fires.
    expect(codes(ctx())).not.toContain("background-heavy");
    // Light lineage: over the ratio but under the minimum size — ignored.
    expect(codes(ctx({ lineage: [lineageEntry("z".repeat(200))] }))).not.toContain("background-heavy");
    // Heavy lineage: over both the minimum and 3x the actionable tier.
    const heavy = contextHealth(ctx({ lineage: [lineageEntry("z".repeat(5000))] }));
    const check = heavy.checks.find((k) => k.code === "background-heavy");
    expect(check?.level).toBe("warn");
    expect(check?.message).toMatch(/~\d+×/);
    // Growing the actionable tier back past the ratio clears it.
    expect(
      codes(ctx({ lineage: [lineageEntry("z".repeat(5000))], artifacts: [ent({ type: "artifact", body: "w".repeat(2000) })] })),
    ).not.toContain("background-heavy");
  });

  it("flags low signal when artifacts dwarf the spec", () => {
    const noisy = ctx({ artifacts: [ent({ type: "artifact", body: "y".repeat(300) })] });
    expect(codes(noisy)).toContain("low-signal");
    // A balanced artifact does not trip it.
    expect(codes(ctx({ artifacts: [ent({ type: "artifact", body: "short" })] }))).not.toContain("low-signal");
  });

  it("always summarizes inherited lineage", () => {
    const flat = contextHealth(ctx()).checks.find((c) => c.code === "inherited-lineage");
    expect(flat?.message).toContain("No inherited context");

    const nested = ctx({
      lineage: [{ requirement: ent({ type: "requirement", title: "Root" }), artifacts: [ent({ type: "artifact" })] }],
    });
    const summary = contextHealth(nested).checks.find((c) => c.code === "inherited-lineage");
    expect(summary?.message).toContain("Inherited 1 ancestor requirement(s) and 1 artifact(s)");
  });

  it("root context: info when lineage is empty, quiet when the root is fully equipped (Phase 14)", () => {
    expect(codes(ctx())).toContain("no-root-context");

    const equipped = ctx({
      lineage: [
        {
          requirement: ent({ type: "requirement", title: "Kiln", body: "the product overview" }),
          artifacts: [],
          blueprint: ent({ type: "blueprint", title: "Architecture", body: "the system overview" }),
        },
      ],
    });
    const found = codes(equipped);
    expect(found).not.toContain("no-root-context");
    expect(found).not.toContain("empty-root-body");
    expect(found).not.toContain("missing-architecture");
  });

  it("root context: warns on an empty root body and a missing root blueprint", () => {
    const bare = ctx({
      lineage: [{ requirement: ent({ type: "requirement", title: "Root", body: "   " }), artifacts: [] }],
    });
    const found = codes(bare);
    expect(found).toContain("empty-root-body");
    expect(found).toContain("missing-architecture");
    expect(contextHealth(bare).checks.filter((c) => c.code.startsWith("empty-root") || c.code === "missing-architecture")
      .every((c) => c.level === "warn")).toBe(true);
  });

  it("root context: only the OUTERMOST lineage entry is judged as the root", () => {
    const nested = ctx({
      lineage: [
        // Nearest ancestor: empty body, no blueprint — not the root, not judged.
        { requirement: ent({ type: "requirement", title: "mid", body: "" }), artifacts: [] },
        {
          requirement: ent({ type: "requirement", title: "Kiln", body: "overview" }),
          artifacts: [],
          blueprint: ent({ type: "blueprint", title: "Architecture", body: "arch" }),
        },
      ],
    });
    const found = codes(nested);
    expect(found).not.toContain("empty-root-body");
    expect(found).not.toContain("missing-architecture");
  });

  it("counts a lineage blueprint toward size and grounding (assembled context, Phase 14)", () => {
    const entry = {
      requirement: ent({ type: "requirement", title: "R", body: "" }),
      artifacts: [],
      blueprint: ent({ type: "blueprint", title: "A", body: "defines `archHelper`" }),
    };
    const base = ctx({ lineage: [{ requirement: entry.requirement, artifacts: [] }] });
    const withBp = ctx({ lineage: [entry] });
    expect(contextHealth(withBp).size.chars).toBe(
      contextHealth(base).size.chars + "A".length + "defines `archHelper`".length,
    );

    const grounded = ctx({ workOrder: ent({ type: "work_order", body: "use `archHelper`" }), lineage: [entry] });
    expect(codes(grounded)).not.toContain("ungrounded-reference");
  });

  it("flags backticked references in the work order absent from the supporting context", () => {
    const ungrounded = ctx({ workOrder: ent({ type: "work_order", body: "reuse `mysteryHelper` here" }) });
    expect(codes(ungrounded)).toContain("ungrounded-reference");

    // Grounded: the identifier appears in the requirement, so it is not flagged.
    const grounded = ctx({
      workOrder: ent({ type: "work_order", body: "reuse `knownHelper`" }),
      requirement: ent({ type: "requirement", body: "provides `knownHelper`" }),
    });
    expect(codes(grounded)).not.toContain("ungrounded-reference");
  });
});
