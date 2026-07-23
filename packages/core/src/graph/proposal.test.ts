import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Entity } from "../domain";
import { applySuggestion } from "../edits/apply";
import { ConstraintError, NotFoundError } from "../errors";
import { DESIGN_DOC_TEMPLATE, seedProject } from "../seed";
import { SqliteStore } from "../store/sqlite-store";
import {
  proposeFeature,
  proposeRootOverview,
  type ProposedFeature,
  type ProposedRootOverview,
} from "./proposal";

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

describe("proposeRootOverview", () => {
  let root: Entity;
  let designDoc: Entity;
  beforeEach(() => {
    // The store already holds `parent` from the shared beforeEach; a fresh
    // project's exact seeded shape is what this path targets, so build one.
    store.deleteEntity(parent.id);
    ({ root, designDoc } = seedProject(store, "Demo"));
  });

  const rootProposal = (): ProposedRootOverview => ({
    overview: "## Overview\nA demo product.\n\n## Non-goals\n- Not a toy.",
    architecture: "## Components\nOne binary.\n\n## Stack\nRust.",
    evidence: [{ title: "README excerpt", body: "Demo does demo things." }],
  });

  it("files the overview and architecture as pending suggestions, committing nothing", () => {
    const ids = proposeRootOverview(store, root.id, rootProposal());

    expect(ids.rootRequirementId).toBe(root.id);
    expect(ids.blueprintId).toBe(designDoc.id);

    // Gate property: both bodies unchanged, no revisions anywhere.
    expect(store.getEntity(root.id)!.body).toBe("");
    expect(store.getEntity(designDoc.id)!.body).toBe(DESIGN_DOC_TEMPLATE);
    expect(store.listRevisions(root.id)).toEqual([]);
    expect(store.listRevisions(designDoc.id)).toEqual([]);

    // Empty root body → empty-anchor insert (the draft-agent shape).
    const [overviewSuggestion] = store.listSuggestions(root.id);
    expect(overviewSuggestion.id).toBe(ids.overviewSuggestionId);
    expect(overviewSuggestion.source).toBe("extract_agent");
    expect(overviewSuggestion.ops).toEqual([
      { kind: "insert", anchor: "", text: rootProposal().overview },
    ]);

    // Seeded template body → whole-body replace, so accepting swaps
    // template for proposal.
    const [architectureSuggestion] = store.listSuggestions(designDoc.id);
    expect(architectureSuggestion.id).toBe(ids.architectureSuggestionId);
    expect(architectureSuggestion.ops).toEqual([
      { kind: "replace", anchor: DESIGN_DOC_TEMPLATE, text: rootProposal().architecture },
    ]);

    // Evidence is ungated source material, references-linked from the root.
    expect(ids.artifactIds).toHaveLength(1);
    expect(store.getEntity(ids.artifactIds[0])!.body).toBe("Demo does demo things.");
    expect(store.linked(root.id, "references").map((e) => e.id)).toEqual(ids.artifactIds);
  });

  it("accepting the suggestions commits exactly the proposed bodies", () => {
    const ids = proposeRootOverview(store, root.id, rootProposal());
    applySuggestion(store, ids.overviewSuggestionId, [0]);
    applySuggestion(store, ids.architectureSuggestionId, [0]);
    expect(store.getEntity(root.id)!.body).toBe(rootProposal().overview);
    expect(store.getEntity(designDoc.id)!.body).toBe(rootProposal().architecture);
  });

  it("evidence is optional — omitting it creates no artifacts", () => {
    const { evidence: _none, ...bare } = rootProposal();
    const ids = proposeRootOverview(store, root.id, bare);
    expect(ids.artifactIds).toEqual([]);
    expect(store.listEntities("artifact")).toEqual([]);
  });

  it("locks the root body while the proposal is pending (anchor lock)", () => {
    proposeRootOverview(store, root.id, rootProposal());
    expect(() => store.updateEntity(root.id, { body: "manual edit" })).toThrow(
      /pending suggestion/,
    );
    expect(() => store.updateEntity(designDoc.id, { body: "manual edit" })).toThrow(
      /pending suggestion/,
    );
  });

  const writesNothing = () => {
    expect(store.listEntities("artifact")).toEqual([]);
    expect(store.listSuggestions(root.id)).toEqual([]);
    expect(store.listSuggestions(designDoc.id)).toEqual([]);
  };

  it.each([
    ["blank overview", { overview: "  " }],
    ["blank architecture", { architecture: "\n\t" }],
    ["blank evidence title", { evidence: [{ title: " ", body: "b" }] }],
    ["blank evidence body", { evidence: [{ title: "T", body: "" }] }],
  ] as Array<[string, Partial<ProposedRootOverview>]>)(
    "rejects %s with ConstraintError, writing nothing",
    (_label, patch) => {
      expect(() => proposeRootOverview(store, root.id, { ...rootProposal(), ...patch })).toThrow(
        ConstraintError,
      );
      writesNothing();
    },
  );

  it("rejects a missing or non-requirement target", () => {
    expect(() => proposeRootOverview(store, "missing", rootProposal())).toThrow(NotFoundError);
    expect(() => proposeRootOverview(store, designDoc.id, rootProposal())).toThrow(
      /not a requirement/,
    );
  });

  it("rejects a requirement that is not the parentless root", () => {
    const child = store.createEntity({ type: "requirement", title: "Feature", body: "" });
    store.link(child.id, root.id, "child_of");
    expect(() => proposeRootOverview(store, child.id, rootProposal())).toThrow(/has a parent/);
  });

  it("rejects a root without a details blueprint", () => {
    store.deleteEntity(designDoc.id);
    expect(() => proposeRootOverview(store, root.id, rootProposal())).toThrow(
      /no details blueprint/,
    );
  });

  it("refuses a non-pristine root body loudly", () => {
    store.updateEntity(root.id, { body: "A hand-written overview." });
    expect(() => proposeRootOverview(store, root.id, rootProposal())).toThrow(
      /non-empty body/,
    );
    writesNothing();
  });

  it("refuses an edited architecture template loudly, accepts the pristine one", () => {
    store.updateEntity(designDoc.id, { body: `${DESIGN_DOC_TEMPLATE}\nedited` });
    expect(() => proposeRootOverview(store, root.id, rootProposal())).toThrow(
      /edited since seeding/,
    );
    writesNothing();

    // An empty blueprint body is also pristine — the proposal lands as an insert.
    store.updateEntity(designDoc.id, { body: "" });
    const ids = proposeRootOverview(store, root.id, rootProposal());
    expect(store.getSuggestion(ids.architectureSuggestionId)!.ops[0].kind).toBe("insert");
  });

  it("refuses to stack on pending suggestions — including its own second call", () => {
    proposeRootOverview(store, root.id, rootProposal());
    expect(() => proposeRootOverview(store, root.id, rootProposal())).toThrow(
      /pending suggestion/,
    );
    // Still exactly one suggestion per document and one evidence artifact.
    expect(store.listSuggestions(root.id)).toHaveLength(1);
    expect(store.listSuggestions(designDoc.id)).toHaveLength(1);
    expect(store.listEntities("artifact")).toHaveLength(1);
  });

  it("compensates a mid-write failure by removing suggestions and artifacts", () => {
    // First saveSuggestion (overview) succeeds, second (architecture) fails.
    let saves = 0;
    const failing = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "saveSuggestion") {
          return (s: Parameters<typeof store.saveSuggestion>[0]) => {
            saves += 1;
            if (saves === 2) throw new Error("disk full");
            return store.saveSuggestion(s);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(() => proposeRootOverview(failing, root.id, rootProposal())).toThrow("disk full");
    writesNothing();
    // The seeded pair itself is untouched.
    expect(store.getEntity(root.id)!.body).toBe("");
    expect(store.getEntity(designDoc.id)!.body).toBe(DESIGN_DOC_TEMPLATE);
  });
});
