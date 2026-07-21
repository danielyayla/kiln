import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectiveWorkType } from "../domain";
import { ConstraintError } from "../errors";
import { SqliteStore } from "./sqlite-store";

let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore(":memory:");
});
afterEach(() => {
  store.close();
});

describe("SqliteStore — entities", () => {
  it("creates and reads an entity", () => {
    const e = store.createEntity({ type: "requirement", title: "Track miles", body: "story" });
    expect(e.id).toBeTruthy();
    expect(e.type).toBe("requirement");
    expect(store.getEntity(e.id)?.title).toBe("Track miles");
  });

  it("rejects invalid entity input", () => {
    expect(() => store.createEntity({ type: "nope" as any, title: "x" })).toThrow();
    expect(() => store.createEntity({ type: "requirement", title: "" })).toThrow();
  });

  it("updates an entity and preserves unset fields", () => {
    const e = store.createEntity({ type: "work_order", title: "WO", body: "a", status: "draft" });
    const u = store.updateEntity(e.id, { status: "ready" });
    expect(u.status).toBe("ready");
    expect(u.title).toBe("WO");
    expect(u.body).toBe("a");
  });

  it("persists workType on work orders and refuses it elsewhere", () => {
    const wo = store.createEntity({ type: "work_order", title: "WO", workType: "bug" });
    expect(wo.workType).toBe("bug");
    expect(store.getEntity(wo.id)?.workType).toBe("bug");

    expect(() => store.createEntity({ type: "requirement", title: "R", workType: "bug" })).toThrow(
      ConstraintError,
    );
    expect(() => store.createEntity({ type: "work_order", title: "W", workType: "nope" as any })).toThrow();

    // Patch semantics mirror status/assignee: undefined keeps, null clears.
    expect(store.updateEntity(wo.id, { workType: "perf" }).workType).toBe("perf");
    expect(store.updateEntity(wo.id, { title: "Renamed" }).workType).toBe("perf");
    expect(store.updateEntity(wo.id, { workType: null }).workType).toBeNull();

    const req = store.createEntity({ type: "requirement", title: "R2" });
    expect(req.workType).toBeNull();
    expect(() => store.updateEntity(req.id, { workType: "chore" })).toThrow(ConstraintError);
  });

  it("resolves the effective work type with feature as the default", () => {
    const typed = store.createEntity({ type: "work_order", title: "W", workType: "refactor" });
    const untyped = store.createEntity({ type: "work_order", title: "W2" });
    expect(effectiveWorkType(typed)).toBe("refactor");
    expect(effectiveWorkType(untyped)).toBe("feature");
  });

  it("deletes an entity and cascades its links, suggestions, and revisions", () => {
    const requirement = store.createEntity({ type: "requirement", title: "R", body: "one" });
    const artifact = store.createEntity({ type: "artifact", title: "A" });
    store.link(requirement.id, artifact.id, "references");
    store.saveSuggestion({
      id: "s-1",
      targetId: requirement.id,
      source: "human",
      ops: [{ kind: "replace", anchor: "one", text: "two" }],
    });
    store.commitBody(requirement.id, "two"); // writes a revision

    // Precondition: the suggestion and revision exist before deletion.
    expect(store.getSuggestion("s-1")).not.toBeNull();
    expect(store.listRevisions(requirement.id)).toHaveLength(1);

    store.deleteEntity(requirement.id);

    expect(store.getEntity(requirement.id)).toBeNull();
    // Cascaded away with the entity.
    expect(store.getSuggestion("s-1")).toBeNull();
    expect(store.listRevisions(requirement.id)).toEqual([]);
    // The edge is gone; the artifact on the other end survives.
    expect(store.linkedFrom(artifact.id, "references")).toEqual([]);
    expect(store.getEntity(artifact.id)).not.toBeNull();
  });

  it("throws when deleting a missing entity", () => {
    expect(() => store.deleteEntity("nope")).toThrow();
  });
});

describe("SqliteStore — links & traversal", () => {
  it("reads linked and linkedFrom in both directions", () => {
    const wo = store.createEntity({ type: "work_order", title: "WO", status: "ready" });
    const bp = store.createEntity({ type: "blueprint", title: "BP" });
    store.link(wo.id, bp.id, "implements");
    expect(store.linked(wo.id, "implements").map((e) => e.id)).toEqual([bp.id]);
    expect(store.linkedFrom(bp.id, "implements").map((e) => e.id)).toEqual([wo.id]);
  });

  it("enforces 1:1 details from a blueprint", () => {
    const bp = store.createEntity({ type: "blueprint", title: "BP" });
    const r1 = store.createEntity({ type: "requirement", title: "R1" });
    const r2 = store.createEntity({ type: "requirement", title: "R2" });
    store.link(bp.id, r1.id, "details");
    expect(() => store.link(bp.id, r2.id, "details")).toThrow(/1:1/);
  });

  it("returns children and the full subtree of the feature tree", () => {
    const root = store.createEntity({ type: "requirement", title: "root" });
    const a = store.createEntity({ type: "requirement", title: "a" });
    const b = store.createEntity({ type: "requirement", title: "b" });
    const a1 = store.createEntity({ type: "requirement", title: "a1" });
    store.link(a.id, root.id, "child_of");
    store.link(b.id, root.id, "child_of");
    store.link(a1.id, a.id, "child_of");
    expect(store.children(root.id).map((e) => e.title).sort()).toEqual(["a", "b"]);
    expect(store.subtree(root.id).map((e) => e.title).sort()).toEqual(["a", "a1", "b", "root"]);
  });

  it("filters work orders by status", () => {
    store.createEntity({ type: "work_order", title: "w1", status: "ready" });
    store.createEntity({ type: "work_order", title: "w2", status: "draft" });
    store.createEntity({ type: "work_order", title: "w3", status: "ready" });
    expect(store.workOrdersByStatus("ready").map((e) => e.title).sort()).toEqual(["w1", "w3"]);
  });
});

describe("SqliteStore — suggestions & search", () => {
  it("saves and lists suggestions round-trip", () => {
    const r = store.createEntity({ type: "requirement", title: "R" });
    store.saveSuggestion({
      id: "s1",
      targetId: r.id,
      source: "draft_agent",
      ops: [{ kind: "insert", anchor: "intro", text: "hello" }],
    });
    const list = store.listSuggestions(r.id);
    expect(list).toHaveLength(1);
    expect(list[0].ops[0]).toMatchObject({ kind: "insert", anchor: "intro", text: "hello" });
  });

  it("rejects a malformed suggestion", () => {
    const r = store.createEntity({ type: "requirement", title: "R" });
    expect(() =>
      store.saveSuggestion({ id: "bad", targetId: r.id, source: "draft_agent", ops: [] } as any),
    ).toThrow();
  });

  it("locks the body while suggestions are pending (anchor lock)", () => {
    const r = store.createEntity({ type: "requirement", title: "R", body: "original" });
    store.saveSuggestion({
      id: "s-lock",
      targetId: r.id,
      source: "draft_agent",
      ops: [{ kind: "replace", anchor: "original", text: "drafted" }],
    });

    // Body edits are refused; anything else still goes through.
    expect(() => store.updateEntity(r.id, { body: "hand edit" })).toThrow(ConstraintError);
    expect(store.updateEntity(r.id, { title: "Renamed" }).title).toBe("Renamed");
    // A no-op body (same bytes) is not a change and passes.
    expect(() => store.updateEntity(r.id, { body: "original" })).not.toThrow();

    // Dismissing unlocks.
    store.deleteSuggestion("s-lock");
    expect(store.updateEntity(r.id, { body: "hand edit" }).body).toBe("hand edit");
  });

  it("full-text searches artifacts only", () => {
    store.createEntity({ type: "artifact", title: "Mileage interview", body: "nurses drive daily" });
    store.createEntity({ type: "requirement", title: "nurses requirement", body: "drive" });
    const hits = store.searchArtifacts("nurses");
    expect(hits).toHaveLength(1);
    expect(hits[0].type).toBe("artifact");
  });
});
