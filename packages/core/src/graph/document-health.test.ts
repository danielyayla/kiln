import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotFoundError } from "../errors";
import { SqliteStore } from "../store/sqlite-store";
import { documentHealth } from "./document-health";

let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore(":memory:");
});
afterEach(() => {
  store.close();
});

const WO_BODY = "## Scope\ndo it\n\n## Out of scope\nnothing else\n\n## Acceptance criteria\n- [ ] works";
const REQ_BODY = "## Capability\nx\n\n## Non-goals\n- none of that";

const codes = (id: string) => documentHealth(store, id).checks.map((c) => c.code);
const level = (id: string, code: string) => documentHealth(store, id).checks.find((c) => c.code === code)?.level;

describe("documentHealth — traceability", () => {
  it("throws NotFoundError for an unknown id", () => {
    expect(() => documentHealth(store, "nope")).toThrow(NotFoundError);
  });

  it("warns on a work order with no implements link", () => {
    const wo = store.createEntity({ type: "work_order", title: "WO", body: WO_BODY });
    expect(codes(wo.id)).toContain("missing-implements");
  });

  it("errors when implements points at a non-blueprint, naming the target", () => {
    const req = store.createEntity({ type: "requirement", title: "The req", body: REQ_BODY });
    const wo = store.createEntity({ type: "work_order", title: "WO", body: WO_BODY });
    store.link(wo.id, req.id, "implements");
    const check = documentHealth(store, wo.id).checks.find((c) => c.code === "implements-not-blueprint");
    expect(check?.level).toBe("error");
    expect(check?.message).toContain('"The req"');
    expect(codes(wo.id)).not.toContain("missing-implements");
  });

  it("is quiet on a correctly linked work order", () => {
    const bp = store.createEntity({ type: "blueprint", title: "BP", body: "## Approach\nx" });
    const wo = store.createEntity({ type: "work_order", title: "WO", body: WO_BODY });
    store.link(wo.id, bp.id, "implements");
    expect(codes(wo.id)).toEqual([]);
  });

  it("warns on an unanchored blueprint, quiet once anchored", () => {
    const bp = store.createEntity({ type: "blueprint", title: "BP", body: "x" });
    expect(codes(bp.id)).toContain("missing-details");

    const r1 = store.createEntity({ type: "requirement", title: "R1", body: "x" });
    store.link(bp.id, r1.id, "details");
    expect(codes(bp.id)).not.toContain("missing-details");
    // A second details link is rejected by the Store itself (1:1) — no
    // multiple-details check exists because the state is unreachable.
    const r2 = store.createEntity({ type: "requirement", title: "R2", body: "x" });
    expect(() => store.link(bp.id, r2.id, "details")).toThrow();
  });

  it("warns on a parentless requirement only when another root anchors a tree", () => {
    const root = store.createEntity({ type: "requirement", title: "Product", body: REQ_BODY });
    const child = store.createEntity({ type: "requirement", title: "Feature", body: REQ_BODY });
    store.link(child.id, root.id, "child_of");

    const detached = store.createEntity({ type: "requirement", title: "Loose", body: REQ_BODY });
    expect(codes(detached.id)).toContain("detached-requirement");
    // The tree's own root is not detached; neither is its child.
    expect(codes(root.id)).not.toContain("detached-requirement");
    expect(codes(child.id)).not.toContain("detached-requirement");
  });

  it("stays quiet on parentless requirements in a genuinely flat store", () => {
    const a = store.createEntity({ type: "requirement", title: "A", body: REQ_BODY });
    store.createEntity({ type: "requirement", title: "B", body: REQ_BODY });
    expect(codes(a.id)).not.toContain("detached-requirement");
  });
});

describe("documentHealth — template shape", () => {
  it("warns on an empty body for any type, and skips shape checks on it", () => {
    const wo = store.createEntity({ type: "work_order", title: "WO", body: "   " });
    const c = codes(wo.id);
    expect(c).toContain("empty-body");
    expect(c).not.toContain("missing-acceptance-criteria");
    const art = store.createEntity({ type: "artifact", title: "A", body: "" });
    expect(codes(art.id)).toContain("empty-body");
  });

  it("warns on a work order without acceptance criteria; a checklist alone satisfies it", () => {
    const bp = store.createEntity({ type: "blueprint", title: "BP", body: "x" });
    const bare = store.createEntity({ type: "work_order", title: "WO", body: "## Scope\njust do it" });
    store.link(bare.id, bp.id, "implements");
    expect(level(bare.id, "missing-acceptance-criteria")).toBe("warn");
    expect(level(bare.id, "missing-out-of-scope")).toBe("info");

    const checklistOnly = store.createEntity({ type: "work_order", title: "WO2", body: "## Scope\nx\n- [ ] proves it" });
    store.link(checklistOnly.id, bp.id, "implements");
    expect(codes(checklistOnly.id)).not.toContain("missing-acceptance-criteria");
  });

  it("flags a requirement without a Non-goals section as info", () => {
    const req = store.createEntity({ type: "requirement", title: "R", body: "## Capability\nx" });
    expect(level(req.id, "missing-non-goals")).toBe("info");
    const good = store.createEntity({ type: "requirement", title: "R2", body: REQ_BODY });
    expect(codes(good.id)).not.toContain("missing-non-goals");
  });

  it("flags a feature title without the `Name — description` shape as info", () => {
    const root = store.createEntity({ type: "requirement", title: "Product", body: REQ_BODY });
    const bad = store.createEntity({ type: "requirement", title: "Board", body: REQ_BODY });
    store.link(bad.id, root.id, "child_of");
    const check = documentHealth(store, bad.id).checks.find((c) => c.code === "feature-title-shape");
    expect(check?.level).toBe("info");
    expect(check?.message).toContain("<Name> — <plain-language description>");
  });

  it("flags a feature title with an empty description after the em-dash", () => {
    const root = store.createEntity({ type: "requirement", title: "Product", body: REQ_BODY });
    const bad = store.createEntity({ type: "requirement", title: "Board — ", body: REQ_BODY });
    store.link(bad.id, root.id, "child_of");
    expect(codes(bad.id)).toContain("feature-title-shape");
  });

  it("is quiet on a compliant feature title", () => {
    const root = store.createEntity({ type: "requirement", title: "Product", body: REQ_BODY });
    const good = store.createEntity({ type: "requirement", title: "Board — status columns for work orders", body: REQ_BODY });
    store.link(good.id, root.id, "child_of");
    expect(codes(good.id)).not.toContain("feature-title-shape");
  });

  it("exempts the product root, nested sub-requirements, and flat stores from the title rule", () => {
    // Product root: parentless, no em-dash — exempt.
    const root = store.createEntity({ type: "requirement", title: "Product", body: REQ_BODY });
    const feature = store.createEntity({ type: "requirement", title: "Board — status columns", body: REQ_BODY });
    store.link(feature.id, root.id, "child_of");
    expect(codes(root.id)).not.toContain("feature-title-shape");

    // Nested sub-requirement (phase-history shape): not a root child — exempt.
    const nested = store.createEntity({ type: "requirement", title: "Phase 5", body: REQ_BODY });
    store.link(nested.id, feature.id, "child_of");
    expect(codes(nested.id)).not.toContain("feature-title-shape");
  });

  it("stays quiet on every requirement in a flat store", () => {
    const a = store.createEntity({ type: "requirement", title: "No emdash here", body: REQ_BODY });
    const b = store.createEntity({ type: "requirement", title: "Child", body: REQ_BODY });
    store.link(b.id, a.id, "child_of");
    // Single tree WITH requirement children reads as a product root by the
    // convention — so this is the accepted-edge case, and the child IS a
    // feature. A truly flat store (siblings, no children) never checks.
    const s1 = store.createEntity({ type: "requirement", title: "Sibling one", body: REQ_BODY });
    const s2 = store.createEntity({ type: "requirement", title: "Sibling two", body: REQ_BODY });
    expect(codes(s1.id)).not.toContain("feature-title-shape");
    expect(codes(s2.id)).not.toContain("feature-title-shape");
    // With two parentless requirements present the convention dissolves, so
    // even the child of the first tree is exempt again.
    expect(codes(b.id)).not.toContain("feature-title-shape");
  });

  it("merges drift checks alongside the shape checks", () => {
    // A done work order with no implements link and no receipt carries both
    // the traceability warn and the drift info in one list.
    const wo = store.createEntity({ type: "work_order", title: "WO", body: WO_BODY });
    store.updateEntity(wo.id, { status: "done" });
    const c = codes(wo.id);
    expect(c).toContain("missing-implements");
    expect(c).toContain("done-without-receipt");
    expect(level(wo.id, "done-without-receipt")).toBe("info");
  });

  it("merges revised-after-done for a done work order revised after its receipt", () => {
    const bp = store.createEntity({ type: "blueprint", title: "BP", body: "## Approach\nx" });
    const wo = store.createEntity({ type: "work_order", title: "WO", body: WO_BODY });
    store.link(wo.id, bp.id, "implements");
    store.updateEntity(wo.id, { status: "done" });
    store.saveCompletionReceipt({
      id: "r1",
      workOrderId: wo.id,
      summary: "built",
      verification: "12 passed",
      commits: [],
      filesTouched: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    store.commitBody(wo.id, WO_BODY + "\ndrifted");
    expect(level(wo.id, "revised-after-done")).toBe("warn");
  });

  it("flags a work order whose title prefix disagrees with its work type", () => {
    const wo = store.createEntity({ type: "work_order", title: "[bug] fix it", body: WO_BODY, workType: "refactor" });
    const check = documentHealth(store, wo.id).checks.find((c) => c.code === "work-type-prefix-mismatch");
    expect(check?.level).toBe("info");
    expect(check?.message).toContain("[bug]");
    expect(check?.message).toContain('"refactor"');
  });

  it("stays quiet when the title prefix matches the field, and treats the prefix case-insensitively", () => {
    const ok = store.createEntity({ type: "work_order", title: "[bug] fix it", body: WO_BODY, workType: "bug" });
    expect(codes(ok.id)).not.toContain("work-type-prefix-mismatch");
    const upper = store.createEntity({ type: "work_order", title: "[BUG] fix it", body: WO_BODY, workType: "bug" });
    expect(codes(upper.id)).not.toContain("work-type-prefix-mismatch");
  });

  it("flags a prefixed title on an unset field (effective feature), and ignores unprefixed titles", () => {
    // Unset field reads as `feature` — a [chore] prefix then misleads.
    const unset = store.createEntity({ type: "work_order", title: "[chore] tidy", body: WO_BODY });
    expect(codes(unset.id)).toContain("work-type-prefix-mismatch");
    // No prefix never mismatches, whatever the field says.
    const plain = store.createEntity({ type: "work_order", title: "Ship the thing", body: WO_BODY, workType: "bug" });
    expect(codes(plain.id)).not.toContain("work-type-prefix-mismatch");
    // `[feature]` is not a recognized prefix — capability work carries none.
    const feat = store.createEntity({ type: "work_order", title: "[feature] add it", body: WO_BODY, workType: "bug" });
    expect(codes(feat.id)).not.toContain("work-type-prefix-mismatch");
  });

  it("legacy documents never error — a pre-methodology store reports info/warn only", () => {
    const req = store.createEntity({ type: "requirement", title: "Old phase", body: "As a builder I want things." });
    const bp = store.createEntity({ type: "blueprint", title: "Old BP", body: "## Approach\nlegacy" });
    store.link(bp.id, req.id, "details");
    const wo = store.createEntity({ type: "work_order", title: "Old WO", body: "just ship it" });
    store.link(wo.id, bp.id, "implements");
    for (const id of [req.id, bp.id, wo.id]) {
      expect(documentHealth(store, id).checks.every((c) => c.level !== "error")).toBe(true);
    }
  });
});
