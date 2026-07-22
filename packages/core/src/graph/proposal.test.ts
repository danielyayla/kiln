import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Entity } from "../domain";
import { ConstraintError, NotFoundError } from "../errors";
import { SqliteStore } from "../store/sqlite-store";
import { proposeFeature, type ProposedFeature } from "./proposal";

let store: SqliteStore;
let parent: Entity;
beforeEach(() => {
  store = new SqliteStore(":memory:");
  parent = store.createEntity({ type: "requirement", title: "Kiln", body: "product root" });
});
afterEach(() => store.close());

const proposal = (): ProposedFeature => ({
  requirement: { title: "Search — find anything", body: "## Capability\nFull-text search." },
  blueprint: { title: "BP — Search", body: "## Approach\nSQLite FTS5." },
  evidence: [
    { title: "src/search.ts excerpt", body: "export function search() {}" },
    { title: "README excerpt", body: "Search ships in v2." },
  ],
});

const storeIsEmpty = () => {
  const entities = ["artifact", "requirement", "blueprint", "work_order"] as const;
  const all = entities.flatMap((t) => store.listEntities(t)).filter((e) => e.id !== parent.id);
  expect(all).toEqual([]);
  expect(store.listLinks()).toEqual([]);
};

describe("proposeFeature — happy path", () => {
  it("creates exactly the gated shape and returns every id", () => {
    const ids = proposeFeature(store, parent.id, proposal());

    const requirement = store.getEntity(ids.requirementId)!;
    expect(requirement.type).toBe("requirement");
    expect(requirement.title).toBe("Search — find anything");

    const blueprint = store.getEntity(ids.blueprintId)!;
    expect(blueprint.type).toBe("blueprint");

    expect(ids.artifactIds).toHaveLength(2);
    const artifacts = ids.artifactIds.map((id) => store.getEntity(id)!);
    expect(artifacts.map((a) => a.type)).toEqual(["artifact", "artifact"]);
    // Evidence is read-only source material: bodies land directly, ungated.
    expect(artifacts.map((a) => a.body)).toEqual([
      "export function search() {}",
      "Search ships in v2.",
    ]);

    // Links: child_of → parent, details → requirement, references → evidence.
    expect(store.linked(requirement.id, "child_of").map((e) => e.id)).toEqual([parent.id]);
    expect(store.linked(blueprint.id, "details").map((e) => e.id)).toEqual([requirement.id]);
    expect(
      store
        .linked(requirement.id, "references")
        .map((e) => e.id)
        .sort(),
    ).toEqual([...ids.artifactIds].sort());

    // Nothing beyond the 3 + 2 entities and 4 links was created.
    expect(store.listEntities("requirement")).toHaveLength(2);
    expect(store.listEntities("blueprint")).toHaveLength(1);
    expect(store.listEntities("artifact")).toHaveLength(2);
    expect(store.listEntities("work_order")).toHaveLength(0);
    expect(store.listLinks()).toHaveLength(4);
  });

  it("files each body as a single empty-anchor insert from extract_agent", () => {
    const ids = proposeFeature(store, parent.id, proposal());

    for (const [targetId, suggestionId, body] of [
      [ids.requirementId, ids.requirementSuggestionId, "## Capability\nFull-text search."],
      [ids.blueprintId, ids.blueprintSuggestionId, "## Approach\nSQLite FTS5."],
    ] as const) {
      const pending = store.listSuggestions(targetId);
      expect(pending.map((s) => s.id)).toEqual([suggestionId]);
      expect(pending[0].source).toBe("extract_agent");
      expect(pending[0].ops).toEqual([{ kind: "insert", anchor: "", text: body }]);
    }
  });

  it("holds the gate property: bodies stay empty and uncommitted until accept", () => {
    const ids = proposeFeature(store, parent.id, proposal());
    expect(store.getEntity(ids.requirementId)!.body).toBe("");
    expect(store.getEntity(ids.blueprintId)!.body).toBe("");
    // No revision exists — nothing was committed.
    expect(store.listRevisions(ids.requirementId)).toEqual([]);
    expect(store.listRevisions(ids.blueprintId)).toEqual([]);
  });
});

describe("proposeFeature — rejections write nothing", () => {
  const rejectionCases: Array<[string, Partial<ProposedFeature>]> = [
    ["blank requirement title", { requirement: { title: "  ", body: "b" } }],
    ["blank requirement body", { requirement: { title: "T", body: "\n\t" } }],
    ["blank blueprint title", { blueprint: { title: "", body: "b" } }],
    ["blank blueprint body", { blueprint: { title: "T", body: "" } }],
    ["empty evidence list", { evidence: [] }],
    ["blank evidence title", { evidence: [{ title: " ", body: "b" }] }],
    ["blank evidence body", { evidence: [{ title: "T", body: "  " }] }],
  ];
  it.each(rejectionCases)("rejects %s with ConstraintError", (_label, patch) => {
    expect(() => proposeFeature(store, parent.id, { ...proposal(), ...patch })).toThrow(
      ConstraintError,
    );
    storeIsEmpty();
  });

  it("rejects a missing parent with NotFoundError", () => {
    expect(() => proposeFeature(store, "missing", proposal())).toThrow(NotFoundError);
    storeIsEmpty();
  });

  it("rejects a parent that is not a requirement with ConstraintError", () => {
    const artifact = store.createEntity({ type: "artifact", title: "A", body: "b" });
    expect(() => proposeFeature(store, artifact.id, proposal())).toThrow(ConstraintError);
    expect(store.listEntities("requirement")).toHaveLength(1);
    expect(store.listEntities("blueprint")).toHaveLength(0);
    expect(store.listLinks()).toEqual([]);
  });

  it("names the offending field in the error message", () => {
    expect(() =>
      proposeFeature(store, parent.id, { ...proposal(), evidence: [] }),
    ).toThrow(/evidence/);
    expect(() =>
      proposeFeature(store, parent.id, {
        ...proposal(),
        blueprint: { title: "T", body: " " },
      }),
    ).toThrow(/blueprint body/);
  });

  it("compensates a mid-write failure by removing everything it created", () => {
    const failing = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "saveSuggestion") {
          return () => {
            throw new Error("disk full");
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(() => proposeFeature(failing, parent.id, proposal())).toThrow("disk full");
    storeIsEmpty();
  });
});
