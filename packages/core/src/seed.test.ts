import { describe, expect, it } from "vitest";
import { productRoot } from "./graph/roots";
import { DESIGN_DOC_TEMPLATE, seedProject } from "./seed";
import { SqliteStore } from "./store";

const store = () => new SqliteStore(":memory:");

describe("seedProject", () => {
  it("seeds the product root and its design-doc blueprint linked details", () => {
    const s = store();
    const { root, designDoc } = seedProject(s, "Acme App");

    expect(root.type).toBe("requirement");
    expect(root.title).toBe("Acme App");
    expect(designDoc.type).toBe("blueprint");
    expect(designDoc.title).toBe("Acme App system architecture");
    expect(designDoc.body).toBe(DESIGN_DOC_TEMPLATE);

    // details direction: blueprint -> requirement
    expect(s.linked(designDoc.id, "details").map((e) => e.id)).toEqual([root.id]);
  });

  it("gives the design doc a non-empty body so missing-architecture stays clear", () => {
    const s = store();
    const { designDoc } = seedProject(s, "X");
    expect(designDoc.body.trim().length).toBeGreaterThan(0);
  });

  it("forms a productRoot from the first minute (the design doc marks it)", () => {
    const s = store();
    const { root } = seedProject(s, "X");
    // The seeded `details` design doc is enough to satisfy the productRoot
    // convention — a fresh project must never render its root as a feature.
    expect(productRoot(s)?.id).toBe(root.id);
  });
});
