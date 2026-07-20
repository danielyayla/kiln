import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../store/sqlite-store";
import { readyGateBlockers } from "./ready-gate";

let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore(":memory:");
});
afterEach(() => {
  store.close();
});

const COMPLETE_BODY = "## Scope\ndo it\n\n## Out of scope\nnothing else\n\n## Acceptance criteria\n- [ ] works";

const blueprint = () => store.createEntity({ type: "blueprint", title: "BP", body: "## Approach\nx" });
const codes = (id: string) => readyGateBlockers(store, id).map((c) => c.code);

describe("readyGateBlockers", () => {
  it("passes a methodology-complete work order", () => {
    const wo = store.createEntity({ type: "work_order", title: "WO", body: COMPLETE_BODY });
    store.link(wo.id, blueprint().id, "implements");
    expect(readyGateBlockers(store, wo.id)).toEqual([]);
  });

  it("blocks on missing-implements, empty-body, and missing-acceptance-criteria", () => {
    const bare = store.createEntity({ type: "work_order", title: "WO", body: "" });
    expect(codes(bare.id)).toEqual(expect.arrayContaining(["missing-implements", "empty-body"]));

    const noCriteria = store.createEntity({ type: "work_order", title: "WO", body: "## Scope\njust do it" });
    store.link(noCriteria.id, blueprint().id, "implements");
    expect(codes(noCriteria.id)).toEqual(["missing-acceptance-criteria"]);
  });

  it("blocks on the implements-not-blueprint error", () => {
    const req = store.createEntity({ type: "requirement", title: "R", body: "x" });
    const wo = store.createEntity({ type: "work_order", title: "WO", body: COMPLETE_BODY });
    store.link(wo.id, req.id, "implements");
    expect(codes(wo.id)).toEqual(["implements-not-blueprint"]);
  });

  it("does not block on non-gating checks (missing-out-of-scope alone passes)", () => {
    const wo = store.createEntity({
      type: "work_order",
      title: "WO",
      body: "## Scope\nx\n\n## Acceptance criteria\n- [ ] works",
    });
    store.link(wo.id, blueprint().id, "implements");
    expect(readyGateBlockers(store, wo.id)).toEqual([]);
  });
});
