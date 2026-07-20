import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { EditOp, Entity } from "../domain";
import { EditError, NotFoundError } from "../errors";
import { SqliteStore } from "../store";
import { applyOp, applySuggestion } from "./apply";

describe("applyOp (pure)", () => {
  const body = "# Title\n\nFirst paragraph.\n\nLast paragraph.";

  it("inserts after the anchor", () => {
    expect(applyOp(body, { kind: "insert", anchor: "# Title", text: "\n\nIntro." }, 0)).toBe(
      "# Title\n\nIntro.\n\nFirst paragraph.\n\nLast paragraph.",
    );
  });

  it("appends when insert anchor is empty", () => {
    expect(applyOp("", { kind: "insert", anchor: "", text: "fresh body" }, 0)).toBe("fresh body");
    expect(applyOp("abc", { kind: "insert", anchor: "", text: "def" }, 0)).toBe("abcdef");
  });

  it("deletes the anchor text", () => {
    expect(applyOp(body, { kind: "delete", anchor: "\n\nLast paragraph." }, 0)).toBe(
      "# Title\n\nFirst paragraph.",
    );
  });

  it("replaces the anchor text", () => {
    expect(applyOp(body, { kind: "replace", anchor: "First", text: "Opening" }, 0)).toBe(
      "# Title\n\nOpening paragraph.\n\nLast paragraph.",
    );
  });

  it("rejects a missing anchor", () => {
    expect(() => applyOp(body, { kind: "delete", anchor: "nope" }, 3)).toThrow(EditError);
    expect(() => applyOp(body, { kind: "delete", anchor: "nope" }, 3)).toThrow(/op 3/);
  });

  it("rejects an ambiguous anchor", () => {
    expect(() => applyOp(body, { kind: "replace", anchor: "paragraph.", text: "x" }, 0)).toThrow(
      /ambiguous/,
    );
  });

  it("rejects empty anchors for delete and replace", () => {
    expect(() => applyOp(body, { kind: "delete", anchor: "" }, 0)).toThrow(EditError);
    expect(() => applyOp(body, { kind: "replace", anchor: "", text: "x" }, 0)).toThrow(EditError);
  });
});

describe("applySuggestion", () => {
  let store: SqliteStore;
  let target: Entity;

  function saveSuggestion(ops: EditOp[]): string {
    const id = randomUUID();
    store.saveSuggestion({ id, targetId: target.id, source: "draft_agent", ops });
    return id;
  }

  beforeEach(() => {
    store = new SqliteStore(":memory:");
    target = store.createEntity({
      type: "requirement",
      title: "Traceable handoff",
      body: "As a builder, I want handoff.\n\nAcceptance: TBD.",
    });
  });

  afterEach(() => store.close());

  it("applies all accepted ops in order and appends exactly one revision", () => {
    const id = saveSuggestion([
      { kind: "replace", anchor: "I want handoff", text: "I want traceable handoff" },
      { kind: "replace", anchor: "Acceptance: TBD.", text: "Acceptance: context arrives in one call." },
      { kind: "insert", anchor: "", text: "\n\nNotes: drafted by agent." },
    ]);

    const { entity, revision } = applySuggestion(store, id, [0, 1, 2]);

    const expected =
      "As a builder, I want traceable handoff.\n\nAcceptance: context arrives in one call.\n\nNotes: drafted by agent.";
    expect(entity.body).toBe(expected);
    expect(store.getEntity(target.id)?.body).toBe(expected);

    const revisions = store.listRevisions(target.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].id).toBe(revision.id);
    expect(revisions[0].body).toBe(expected);

    // Resolution consumes the suggestion.
    expect(store.getSuggestion(id)).toBeNull();
    expect(store.listSuggestions(target.id)).toEqual([]);
  });

  it("applies only the accepted subset, in suggestion order regardless of call order", () => {
    const id = saveSuggestion([
      { kind: "replace", anchor: "As a builder", text: "As a solo builder" },
      { kind: "delete", anchor: "\n\nAcceptance: TBD." },
      { kind: "insert", anchor: "", text: "\n\nExtra." },
    ]);

    // Accept ops 2 and 0, reject op 1 — listed out of order on purpose.
    const { entity } = applySuggestion(store, id, [2, 0]);

    expect(entity.body).toBe("As a solo builder, I want handoff.\n\nAcceptance: TBD.\n\nExtra.");
    expect(store.listRevisions(target.id)).toHaveLength(1);
  });

  it("is atomic: a failing accepted op leaves body and revisions untouched", () => {
    const id = saveSuggestion([
      { kind: "replace", anchor: "As a builder", text: "CHANGED" },
      { kind: "delete", anchor: "this anchor does not exist" },
    ]);

    expect(() => applySuggestion(store, id, [0, 1])).toThrow(EditError);

    expect(store.getEntity(target.id)?.body).toBe("As a builder, I want handoff.\n\nAcceptance: TBD.");
    expect(store.listRevisions(target.id)).toHaveLength(0);
    // A failed apply leaves the suggestion pending.
    expect(store.getSuggestion(id)).not.toBeNull();
  });

  it("rejects out-of-range, duplicate, and empty accepted indexes", () => {
    const id = saveSuggestion([{ kind: "insert", anchor: "", text: "x" }]);

    expect(() => applySuggestion(store, id, [1])).toThrow(/out of range/);
    expect(() => applySuggestion(store, id, [-1])).toThrow(/out of range/);
    expect(() => applySuggestion(store, id, [0, 0])).toThrow(/duplicated/);
    expect(() => applySuggestion(store, id, [])).toThrow(/no ops accepted/);
    // None of the failures touched the store.
    expect(store.listRevisions(target.id)).toHaveLength(0);
  });

  it("throws NotFoundError for an unknown suggestion", () => {
    expect(() => applySuggestion(store, "missing", [0])).toThrow(NotFoundError);
  });

  it("accumulates revisions across successive applies", () => {
    const first = saveSuggestion([{ kind: "replace", anchor: "TBD", text: "v1" }]);
    applySuggestion(store, first, [0]);
    const second = saveSuggestion([{ kind: "replace", anchor: "v1", text: "v2" }]);
    applySuggestion(store, second, [0]);

    const revisions = store.listRevisions(target.id);
    expect(revisions).toHaveLength(2);
    expect(revisions.map((r) => r.body.includes("v2"))).toEqual([false, true]);
    expect(store.getEntity(target.id)?.body).toContain("v2");
  });
});
