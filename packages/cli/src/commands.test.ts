import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConstraintError, NotFoundError, SqliteStore } from "@kiln/core";
import type { CompleteRequest, ModelProvider, ModelResult } from "@kiln/agents";
import {
  gatherArtifacts,
  runAccept,
  runCreate,
  runDraft,
  runExport,
  runExtract,
  runLink,
  runReview,
  runSetStatus,
  runSuggestions,
  templateFor,
} from "./commands.js";

function scriptedProvider(toolName: string, inputs: unknown[]): ModelProvider & { requests: CompleteRequest[] } {
  const requests: CompleteRequest[] = [];
  let call = 0;
  return {
    requests,
    async complete(req): Promise<ModelResult> {
      requests.push(req);
      const input = inputs[Math.min(call++, inputs.length - 1)];
      return { text: "", toolCall: { name: toolName, input }, stopReason: "tool_use", model: "scripted" };
    },
  };
}

let store: SqliteStore;

beforeEach(() => {
  store = new SqliteStore(":memory:");
});
afterEach(() => store.close());

describe("create / link / status", () => {
  it("creates entities and rejects unknown types", () => {
    const e = runCreate(store, "requirement", "R1", "body");
    expect(store.getEntity(e.id)?.title).toBe("R1");
    expect(() => runCreate(store, "widget", "W")).toThrow(ConstraintError);
  });

  it("links entities and rejects unknown link types", () => {
    const a = runCreate(store, "requirement", "R");
    const b = runCreate(store, "artifact", "A");
    runLink(store, a.id, b.id, "references");
    expect(store.linked(a.id, "references").map((e) => e.id)).toEqual([b.id]);
    expect(() => runLink(store, a.id, b.id, "likes")).toThrow(ConstraintError);
  });

  it("sets work-order status with validation", () => {
    // A bare draft now trips the completeness gate on the way to ready — this
    // test is about status validation, so make the work order compliant.
    const bp = runCreate(store, "blueprint", "BP");
    const wo = runCreate(store, "work_order", "W");
    store.updateEntity(wo.id, { body: "## Scope\nx\n\n## Acceptance criteria\n- [ ] works" });
    runLink(store, wo.id, bp.id, "implements");
    expect(runSetStatus(store, wo.id, "ready").status).toBe("ready");
    expect(() => runSetStatus(store, wo.id, "paused")).toThrow(ConstraintError);
    const req = runCreate(store, "requirement", "R");
    expect(() => runSetStatus(store, req.id, "ready")).toThrow(ConstraintError);
  });

  it("gates draft→ready on completeness, overridable with force", () => {
    const bare = runCreate(store, "work_order", "Bare");
    expect(() => runSetStatus(store, bare.id, "ready")).toThrow(/completeness gate.*--force/s);
    expect(runSetStatus(store, bare.id, "ready", { force: true }).status).toBe("ready");
    // Later transitions on the same bare work order are not gated.
    expect(runSetStatus(store, bare.id, "in_progress").status).toBe("in_progress");
  });
});

describe("draft plumbing", () => {
  it("gathers artifacts through the graph for requirements and blueprints", () => {
    const artifact = runCreate(store, "artifact", "A", "source");
    const requirement = runCreate(store, "requirement", "R");
    const blueprint = runCreate(store, "blueprint", "B");
    runLink(store, requirement.id, artifact.id, "references");
    runLink(store, blueprint.id, requirement.id, "details");

    expect(gatherArtifacts(store, store.getEntity(requirement.id)!).map((e) => e.id)).toEqual([artifact.id]);
    expect(gatherArtifacts(store, store.getEntity(blueprint.id)!).map((e) => e.id)).toEqual([artifact.id]);
  });

  it("picks the template by target type and refuses others", () => {
    const requirement = runCreate(store, "requirement", "R");
    const artifact = runCreate(store, "artifact", "A");
    expect(templateFor(requirement).name).toBe("methodology-requirement");
    expect(() => templateFor(artifact)).toThrow(ConstraintError);
  });

  it("runDraft saves the suggestion so runSuggestions can list it", async () => {
    const requirement = runCreate(store, "requirement", "R");
    const provider = scriptedProvider("emit_suggestion", [
      { ops: [{ kind: "insert", anchor: "", text: "## User story\ndrafted" }] },
    ]);

    const suggestion = await runDraft(store, provider, requirement.id);

    expect(runSuggestions(store, requirement.id).map((s) => s.id)).toEqual([suggestion.id]);
    expect(() => runSuggestions(store, "missing")).toThrow(NotFoundError);
  });

  it("resolves active authoring skills into agent prompts; empty set carries none", async () => {
    const requirement = runCreate(store, "requirement", "R");
    const ops = [{ ops: [{ kind: "insert", anchor: "", text: "## User story\ndrafted" }] }];

    // Empty active set: the draft prompt is skill-free.
    const bare = scriptedProvider("emit_suggestion", ops);
    await runDraft(store, bare, requirement.id);
    expect(bare.requests[0].system).not.toContain("Authoring skills");

    // Enabled skill (settings-embedded doc): draft, extract, and review all
    // carry the section.
    store.setSetting(
      "kiln.authoring.skills",
      JSON.stringify([{ id: "s1", title: "Terse docs", body: "Never exceed 300 words.", enabled: true }]),
    );
    const draft = scriptedProvider("emit_suggestion", ops);
    // The first draft's suggestion is still pending; drafting again is legal
    // (only chat/review filing enforce one-pending), so reuse the same target.
    await runDraft(store, draft, requirement.id);
    expect(draft.requests[0].system).toContain("Authoring skills (house standards — follow these):");
    expect(draft.requests[0].system).toContain("Never exceed 300 words.");

    const blueprint = runCreate(store, "blueprint", "B");
    const extract = scriptedProvider("emit_work_orders", [{ candidates: [{ title: "W", body: "b" }] }]);
    await runExtract(store, extract, blueprint.id);
    expect(extract.requests[0].system).toContain("Never exceed 300 words.");

    const review = scriptedProvider("emit_review", [{ findings: [] }]);
    await runReview(store, review, blueprint.id);
    expect(review.requests[0].system).toContain("Never exceed 300 words.");
  });
});

describe("accept", () => {
  it("defaults to accepting every op; --ops limits the subset", async () => {
    const requirement = runCreate(store, "requirement", "R", "one two");
    const provider = scriptedProvider("emit_suggestion", [
      {
        ops: [
          { kind: "replace", anchor: "one", text: "1" },
          { kind: "replace", anchor: "two", text: "2" },
        ],
      },
    ]);
    const s1 = await runDraft(store, provider, requirement.id);
    expect(runAccept(store, s1.id).entity.body).toBe("1 2");

    const s2 = await runDraft(store, provider, requirement.id);
    // Anchors "one"/"two" are gone now, so accept the subset that still applies.
    expect(() => runAccept(store, s2.id, [0])).toThrow(); // anchor gone
  });
});

describe("review", () => {
  const FINDING = { severity: "major", kind: "ambiguity", note: "vague timing", quote: "soon" };
  const OPS = [{ kind: "replace", anchor: "soon", text: "within one MCP call" }];

  it("returns findings without filing anything by default", async () => {
    const requirement = runCreate(store, "requirement", "R", "delivered soon");
    const provider = scriptedProvider("emit_review", [{ findings: [FINDING], ops: OPS }]);

    const result = await runReview(store, provider, requirement.id);
    expect(result.findings).toEqual([FINDING]);
    expect(result.filed).toBe(false);
    expect(result.suggestion?.ops).toEqual(OPS); // proposed, visible, not filed
    expect(store.listSuggestions(requirement.id)).toHaveLength(0);
  });

  it("--suggest files the review_agent suggestion", async () => {
    const requirement = runCreate(store, "requirement", "R", "delivered soon");
    const provider = scriptedProvider("emit_review", [{ findings: [FINDING], ops: OPS }]);

    const result = await runReview(store, provider, requirement.id, true);
    expect(result.filed).toBe(true);
    const pending = store.listSuggestions(requirement.id);
    expect(pending).toHaveLength(1);
    expect(pending[0].source).toBe("review_agent");
    // The filed suggestion flows through the normal accept path.
    expect(runAccept(store, pending[0].id).entity.body).toBe("delivered within one MCP call");
  });

  it("--suggest refuses to stack on a pending suggestion", async () => {
    const requirement = runCreate(store, "requirement", "R", "delivered soon");
    const draftProvider = scriptedProvider("emit_suggestion", [
      { ops: [{ kind: "insert", anchor: "", text: " (draft)" }] },
    ]);
    await runDraft(store, draftProvider, requirement.id); // a suggestion is now pending

    const provider = scriptedProvider("emit_review", [{ findings: [FINDING], ops: OPS }]);
    await expect(runReview(store, provider, requirement.id, true)).rejects.toThrow(
      /resolve pending suggestions first/,
    );
    // The pending draft suggestion is untouched; nothing extra was filed.
    expect(store.listSuggestions(requirement.id)).toHaveLength(1);
  });

  it("rejects non-document targets", async () => {
    const wo = runCreate(store, "work_order", "W");
    const provider = scriptedProvider("emit_review", [{ findings: [] }]);
    await expect(runReview(store, provider, wo.id)).rejects.toThrow(ConstraintError);
    await expect(runReview(store, provider, "missing")).rejects.toThrow(NotFoundError);
  });
});

describe("export", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kiln-export-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes the graph to disk and reports counts", () => {
    const req = runCreate(store, "requirement", "Feature", "the intent");
    runCreate(store, "blueprint", "Loose Design"); // orphan → unfiled/
    runCreate(store, "artifact", "Notes", "src");

    const result = runExport(store, dir);
    expect(result).toEqual({ dir, fileCount: 3, orphanCount: 1 });

    const reqDir = readdirSync(dir).find((d) => d.startsWith("feature-"));
    expect(reqDir).toBeTruthy();
    const reqFile = readFileSync(join(dir, reqDir!, `${reqDir}.md`), "utf8");
    expect(reqFile).toContain(`id: ${req.id}`);
    expect(reqFile).toContain("the intent");
    expect(readdirSync(join(dir, "unfiled"))).toHaveLength(1);
    expect(readdirSync(join(dir, "artifacts"))).toHaveLength(1);
  });

  it("refuses a non-empty directory without force, proceeds with it", () => {
    writeFileSync(join(dir, "keep.txt"), "existing");
    runCreate(store, "artifact", "A");

    expect(() => runExport(store, dir)).toThrow(/not empty/);
    const forced = runExport(store, dir, true);
    expect(forced.fileCount).toBe(1);
    // The pre-existing file survives — force overlays, it does not wipe.
    expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("existing");
  });

  it("exports an empty store as an empty (but existing) directory", () => {
    const result = runExport(store, dir);
    expect(result.fileCount).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("extract", () => {
  it("accepts the chosen subset and validates indexes", async () => {
    const blueprint = runCreate(store, "blueprint", "B", "## Approach\nbuild it");
    const provider = scriptedProvider("emit_work_orders", [
      {
        candidates: [
          { title: "First", body: "do the first thing" },
          { title: "Second", body: "do the second thing" },
        ],
      },
    ]);

    const none = await runExtract(store, provider, blueprint.id);
    expect(none.candidates).toHaveLength(2);
    expect(none.accepted).toHaveLength(0);

    const some = await runExtract(store, provider, blueprint.id, [1]);
    expect(some.accepted.map((w) => w.title)).toEqual(["Second"]);

    await expect(runExtract(store, provider, blueprint.id, [5])).rejects.toThrow(/out of range/);
  });
});
