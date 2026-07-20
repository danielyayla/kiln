import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../store/sqlite-store";
import { exportGraph } from "./export";

let store: SqliteStore;
beforeEach(() => {
  store = new SqliteStore(":memory:");
});
afterEach(() => {
  store.close();
});

const short = (id: string) => id.slice(0, 8);
const byPath = (path: string) => {
  const f = exportGraph(store).find((f) => f.relativePath === path);
  expect(f, `expected file at ${path}`).toBeTruthy();
  return f!;
};

describe("exportGraph layout", () => {
  it("nests requirement folders by child_of, with blueprints and work orders beside their requirement", () => {
    const root = store.createEntity({ type: "requirement", title: "Root Feature", body: "root intent" });
    const child = store.createEntity({ type: "requirement", title: "Sub Feature", body: "sub intent" });
    const bp = store.createEntity({ type: "blueprint", title: "The Design", body: "how" });
    const wo = store.createEntity({ type: "work_order", title: "Build It", body: "do it", status: "ready" });
    const art = store.createEntity({ type: "artifact", title: "Meeting Notes", body: "source" });
    store.link(child.id, root.id, "child_of");
    store.link(bp.id, child.id, "details");
    store.link(wo.id, bp.id, "implements");
    store.link(root.id, art.id, "references");

    const paths = exportGraph(store).map((f) => f.relativePath);
    const rootDir = `root-feature-${short(root.id)}/`;
    const childDir = `${rootDir}sub-feature-${short(child.id)}/`;
    expect(paths).toEqual(
      [
        `artifacts/meeting-notes-${short(art.id)}.md`,
        `${rootDir}root-feature-${short(root.id)}.md`,
        `${childDir}build-it-${short(wo.id)}.md`,
        `${childDir}sub-feature-${short(child.id)}.md`,
        `${childDir}the-design-${short(bp.id)}.md`,
      ].sort(),
    );
  });

  it("writes front-matter (id/type/title/status/links with titles) and the body verbatim", () => {
    const req = store.createEntity({ type: "requirement", title: 'Tricky: "Title"', body: "## Line one\n\nline two" });
    const art = store.createEntity({ type: "artifact", title: "Notes", body: "" });
    const wo = store.createEntity({ type: "work_order", title: "W", body: "work", status: "in_progress" });
    store.link(req.id, art.id, "references");

    const reqFile = byPath(`tricky-title-${short(req.id)}/tricky-title-${short(req.id)}.md`);
    expect(reqFile.contents).toContain(`id: ${req.id}`);
    expect(reqFile.contents).toContain("type: requirement");
    expect(reqFile.contents).toContain(`title: "Tricky: \\"Title\\""`);
    expect(reqFile.contents).not.toContain("status:"); // null status omitted
    expect(reqFile.contents).toContain("links:");
    expect(reqFile.contents).toContain("  references:");
    expect(reqFile.contents).toContain(`    - id: ${art.id}`);
    expect(reqFile.contents).toContain(`      title: "Notes"`);
    // Body verbatim after the front-matter fence.
    expect(reqFile.contents).toContain("---\n\n## Line one\n\nline two\n");

    const woFile = byPath(`unfiled/w-${short(wo.id)}.md`);
    expect(woFile.contents).toContain("status: in_progress");

    // Empty body → front-matter only, no trailing body block.
    const artFile = byPath(`artifacts/notes-${short(art.id)}.md`);
    expect(artFile.contents.endsWith("---\n")).toBe(true);
  });

  it("exports unplaced entities under unfiled/ so nothing is silently dropped", () => {
    // A blueprint detailing nothing and a work order implementing nothing.
    const bp = store.createEntity({ type: "blueprint", title: "Loose Design", body: "x" });
    const wo = store.createEntity({ type: "work_order", title: "Loose Work", body: "y", status: "draft" });

    const paths = exportGraph(store).map((f) => f.relativePath);
    expect(paths).toEqual([
      `unfiled/loose-design-${short(bp.id)}.md`,
      `unfiled/loose-work-${short(wo.id)}.md`,
    ]);
  });

  it("keeps colliding slugs distinct via the id suffix", () => {
    const a = store.createEntity({ type: "requirement", title: "Same Title" });
    const b = store.createEntity({ type: "requirement", title: "Same Title" });

    const paths = exportGraph(store).map((f) => f.relativePath);
    expect(new Set(paths).size).toBe(2);
    expect(paths.join()).toContain(short(a.id));
    expect(paths.join()).toContain(short(b.id));
  });

  it("slugifies awkward titles and never emits an empty slug", () => {
    const weird = store.createEntity({ type: "requirement", title: "  Éxpörts!! (v2) " });
    const empty = store.createEntity({ type: "requirement", title: "!!!" });

    const paths = exportGraph(store).map((f) => f.relativePath);
    expect(paths).toContain(`exports-v2-${short(weird.id)}/exports-v2-${short(weird.id)}.md`);
    expect(paths).toContain(`untitled-${short(empty.id)}/untitled-${short(empty.id)}.md`);
  });

  it("is deterministic: reruns are byte-identical", () => {
    const root = store.createEntity({ type: "requirement", title: "Root" });
    const child = store.createEntity({ type: "requirement", title: "Child" });
    store.link(child.id, root.id, "child_of");
    store.createEntity({ type: "artifact", title: "A" });
    store.createEntity({ type: "blueprint", title: "Loose" });

    const first = exportGraph(store);
    const second = exportGraph(store);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("exports an empty store as zero files", () => {
    expect(exportGraph(store)).toEqual([]);
  });
});
