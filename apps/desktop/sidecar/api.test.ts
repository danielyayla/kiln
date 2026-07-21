import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordContextReceipt, SqliteStore, type Entity, type FeatureTreeNode } from "@kiln/core";
import type { ModelProvider, ModelResult } from "@kiln/agents";
import { buildApi } from "./api.js";

let store: SqliteStore;
let app: ReturnType<typeof buildApi>;

beforeEach(() => {
  store = new SqliteStore(":memory:");
  app = buildApi(store);
});
afterEach(() => store.close());

// A provider that replays one scripted tool call, for the authoring routes.
function scriptedProvider(name: string, input: unknown): ModelProvider {
  return {
    async complete(): Promise<ModelResult> {
      return { text: "", toolCall: { name, input }, stopReason: "tool_use", model: "scripted" };
    },
  };
}

async function json<T>(res: Response): Promise<T> {
  expect(res.headers.get("content-type")).toContain("application/json");
  return (await res.json()) as T;
}

describe("sidecar API", () => {
  it("reports health with provider availability", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    // The default app probes the real provider factory, so availability
    // depends on the host env — assert the shape, not the value.
    expect(await json(res)).toEqual({ ok: true, providerAvailable: expect.any(Boolean), aiEnabled: true });
  });

  it("health reflects the injected provider factory", async () => {
    const withProvider = buildApi(store, { createProvider: () => scriptedProvider("noop", {}) });
    expect(await json(await withProvider.request("/health"))).toEqual({
      ok: true,
      providerAvailable: true,
      aiEnabled: true,
    });

    const withoutProvider = buildApi(store, {
      createProvider: () => {
        throw new Error("no credentials");
      },
    });
    expect(await json(await withoutProvider.request("/health"))).toEqual({
      ok: true,
      providerAvailable: false,
      aiEnabled: true,
    });
  });

  it("creates and lists requirements (the WO-13 round trip)", async () => {
    const created = await app.request("/entities", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "requirement", title: "Traceable handoff" }),
    });
    expect(created.status).toBe(201);
    const entity = await json<Entity>(created);

    const list = await app.request("/entities?type=requirement");
    expect(list.status).toBe(200);
    expect((await json<Entity[]>(list)).map((e) => e.id)).toEqual([entity.id]);
  });

  it("gets, patches, and 404s entities", async () => {
    const requirement = store.createEntity({ type: "requirement", title: "R" });

    const got = await json<Entity>(await app.request(`/entities/${requirement.id}`));
    expect(got.title).toBe("R");

    const patched = await app.request(`/entities/${requirement.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed" }),
    });
    expect((await json<Entity>(patched)).title).toBe("Renamed");

    expect((await app.request("/entities/nope")).status).toBe(404);
  });

  it("filters work orders by status", async () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "ready" });
    store.createEntity({ type: "work_order", title: "W2", status: "draft" });

    const ready = await json<Entity[]>(await app.request("/entities?status=ready"));
    expect(ready.map((e) => e.id)).toEqual([wo.id]);
  });

  it("links entities and assembles context", async () => {
    const artifact = store.createEntity({ type: "artifact", title: "A" });
    const requirement = store.createEntity({ type: "requirement", title: "R" });
    const blueprint = store.createEntity({ type: "blueprint", title: "B" });
    const workOrder = store.createEntity({ type: "work_order", title: "W", status: "ready" });

    for (const [fromId, toId, type] of [
      [workOrder.id, blueprint.id, "implements"],
      [blueprint.id, requirement.id, "details"],
      [requirement.id, artifact.id, "references"],
    ] as const) {
      const res = await app.request("/links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fromId, toId, type }),
      });
      expect(res.status).toBe(201);
    }

    const ctx = await json<{ blueprint: Entity | null; requirement: Entity | null; artifacts: Entity[] }>(
      await app.request(`/entities/${workOrder.id}/context`),
    );
    expect(ctx.blueprint?.id).toBe(blueprint.id);
    expect(ctx.requirement?.id).toBe(requirement.id);
    expect(ctx.artifacts.map((a) => a.id)).toEqual([artifact.id]);
  });

  it("serves the nested feature tree", async () => {
    const root = store.createEntity({ type: "requirement", title: "Root" });
    const child = store.createEntity({ type: "requirement", title: "Child" });
    store.link(child.id, root.id, "child_of");

    const tree = await json<{ entity: Entity; children: { entity: Entity }[] }[]>(
      await app.request("/tree"),
    );
    expect(tree).toHaveLength(1);
    expect(tree[0].entity.id).toBe(root.id);
    expect(tree[0].children.map((n) => n.entity.id)).toEqual([child.id]);
  });

  it("expands the tree with blueprints and work orders on ?expand=chain", async () => {
    const root = store.createEntity({ type: "requirement", title: "Root" });
    const blueprint = store.createEntity({ type: "blueprint", title: "BP" });
    store.link(blueprint.id, root.id, "details");
    const wo = store.createEntity({ type: "work_order", title: "WO" });
    store.link(wo.id, blueprint.id, "implements");

    const tree = await json<FeatureTreeNode[]>(await app.request("/tree?expand=chain"));
    expect(tree[0].blueprints?.map((b) => b.entity.id)).toEqual([blueprint.id]);
    expect(tree[0].blueprints?.[0].workOrders.map((w) => w.id)).toEqual([wo.id]);

    // Junk expand values are rejected, not silently ignored.
    expect((await app.request("/tree?expand=everything")).status).toBe(400);
  });

  it("serves child_of ancestors nearest-first", async () => {
    const root = store.createEntity({ type: "requirement", title: "Root" });
    const mid = store.createEntity({ type: "requirement", title: "Mid" });
    const leaf = store.createEntity({ type: "requirement", title: "Leaf" });
    store.link(mid.id, root.id, "child_of");
    store.link(leaf.id, mid.id, "child_of");

    const chain = await json<Entity[]>(await app.request(`/entities/${leaf.id}/ancestors`));
    expect(chain.map((e) => e.id)).toEqual([mid.id, root.id]);

    expect((await app.request("/entities/nope/ancestors")).status).toBe(404);
  });

  it("restores a revision via commitBody and appends exactly one new revision", async () => {
    const req = store.createEntity({ type: "requirement", title: "R", body: "v1" });
    store.commitBody(req.id, "v2"); // history: [v2]
    const before = store.listRevisions(req.id);
    const v2 = before.find((r) => r.body === "v2")!;
    store.commitBody(req.id, "v3"); // history: [v3, v2]

    const res = await app.request(`/entities/${req.id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revisionId: v2.id }),
    });
    expect(res.status).toBe(200);
    const { entity } = await json<{ entity: Entity }>(res);
    expect(entity.body).toBe("v2");
    // exactly one revision appended by the restore
    expect(store.listRevisions(req.id)).toHaveLength(3);

    // a revision id from another entity 404s
    const other = store.createEntity({ type: "requirement", title: "O", body: "x" });
    const missing = await app.request(`/entities/${other.id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revisionId: v2.id }),
    });
    expect(missing.status).toBe(404);
  });

  it("serves linked and linked-from edges", async () => {
    const requirement = store.createEntity({ type: "requirement", title: "R" });
    const artifact = store.createEntity({ type: "artifact", title: "A" });
    const blueprint = store.createEntity({ type: "blueprint", title: "B" });
    store.link(requirement.id, artifact.id, "references");
    store.link(blueprint.id, requirement.id, "details");

    const refs = await json<Entity[]>(await app.request(`/entities/${requirement.id}/linked/references`));
    expect(refs.map((e) => e.id)).toEqual([artifact.id]);

    const detailing = await json<Entity[]>(
      await app.request(`/entities/${requirement.id}/linked-from/details`),
    );
    expect(detailing.map((e) => e.id)).toEqual([blueprint.id]);

    expect((await app.request(`/entities/${requirement.id}/linked/likes`)).status).toBe(400);
  });

  it("saves, applies, and consumes suggestions with revisions", async () => {
    const requirement = store.createEntity({ type: "requirement", title: "R", body: "alpha beta" });

    const saved = await app.request("/suggestions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetId: requirement.id,
        source: "draft_agent",
        ops: [
          { kind: "replace", anchor: "alpha", text: "ALPHA" },
          { kind: "delete", anchor: " beta" },
        ],
      }),
    });
    expect(saved.status).toBe(201);
    const suggestion = await json<{ id: string }>(saved);

    const pending = await json<unknown[]>(await app.request(`/entities/${requirement.id}/suggestions`));
    expect(pending).toHaveLength(1);

    // Accept op 0, reject op 1.
    const applied = await app.request(`/suggestions/${suggestion.id}/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ acceptedOpIndexes: [0] }),
    });
    expect(applied.status).toBe(200);
    const { entity } = await json<{ entity: Entity }>(applied);
    expect(entity.body).toBe("ALPHA beta");

    // Consumed, and a revision exists.
    expect(await json<unknown[]>(await app.request(`/entities/${requirement.id}/suggestions`))).toEqual([]);
    expect(await json<unknown[]>(await app.request(`/entities/${requirement.id}/revisions`))).toHaveLength(1);
  });

  it("dismisses a suggestion without touching the document", async () => {
    const requirement = store.createEntity({ type: "requirement", title: "R", body: "keep me" });
    store.saveSuggestion({
      id: "s-1",
      targetId: requirement.id,
      source: "human",
      ops: [{ kind: "delete", anchor: "keep me" }],
    });

    const res = await app.request("/suggestions/s-1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await json<unknown[]>(await app.request(`/entities/${requirement.id}/suggestions`))).toEqual([]);
    expect((await json<Entity>(await app.request(`/entities/${requirement.id}`))).body).toBe("keep me");
  });

  it("refuses a body edit while a suggestion is pending (anchor lock)", async () => {
    const requirement = store.createEntity({ type: "requirement", title: "R", body: "anchored text" });
    store.saveSuggestion({
      id: "s-lock",
      targetId: requirement.id,
      source: "draft_agent",
      ops: [{ kind: "replace", anchor: "anchored", text: "drafted" }],
    });

    const res = await app.request(`/entities/${requirement.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hand edit" }),
    });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toContain("pending suggestion");

    // Dismiss, then the same edit succeeds.
    await app.request("/suggestions/s-lock", { method: "DELETE" });
    const retry = await app.request(`/entities/${requirement.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hand edit" }),
    });
    expect(retry.status).toBe(200);
  });

  it("deletes an entity and 404s a missing one", async () => {
    const requirement = store.createEntity({ type: "requirement", title: "R" });

    const del = await app.request(`/entities/${requirement.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(store.getEntity(requirement.id)).toBeNull();

    expect((await app.request("/entities/nope", { method: "DELETE" })).status).toBe(404);
  });

  it("enforces the work-order status lifecycle on PATCH", async () => {
    // Methodology-complete so the draft→ready leg exercises the lifecycle,
    // not the completeness gate (which has its own test below).
    const bp = store.createEntity({ type: "blueprint", title: "BP", body: "## Approach\nx" });
    const wo = store.createEntity({
      type: "work_order",
      title: "W",
      status: "draft",
      body: "## Scope\nx\n\n## Acceptance criteria\n- [ ] works",
    });
    store.link(wo.id, bp.id, "implements");

    // draft → in_progress skips a stage: rejected.
    const skip = await app.request(`/entities/${wo.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    });
    expect(skip.status).toBe(400);
    expect((await json<{ error: string }>(skip)).error).toContain("Invalid status transition");

    // draft → ready is allowed.
    const ok = await app.request(`/entities/${wo.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "ready" }),
    });
    expect(ok.status).toBe(200);
    expect((await json<Entity>(ok)).status).toBe("ready");

    // A non-status patch is unaffected by the lifecycle.
    const assign = await app.request(`/entities/${wo.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignee: "dan" }),
    });
    expect((await json<Entity>(assign)).assignee).toBe("dan");
  });

  it("exposes the legal next statuses", async () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "ready" });
    const t = await json<{ current: string; allowed: string[] }>(
      await app.request(`/entities/${wo.id}/transitions`),
    );
    expect(t.current).toBe("ready");
    expect(t.allowed).toEqual(["in_progress", "cancelled"]);
  });

  it("drafts into a requirement via an injected provider and saves the suggestion", async () => {
    const requirement = store.createEntity({ type: "requirement", title: "Traceable handoff" });
    const draftApp = buildApi(store, {
      createProvider: () =>
        scriptedProvider("emit_suggestion", {
          ops: [{ kind: "insert", anchor: "", text: "## User story\ndrafted content" }],
        }),
    });

    const res = await draftApp.request(`/entities/${requirement.id}/draft`, { method: "POST" });
    expect(res.status).toBe(200);
    const suggestion = await json<{ id: string; ops: unknown[] }>(res);
    expect(suggestion.ops).toHaveLength(1);
    // Persisted so the editor can pick it up.
    expect(store.getSuggestion(suggestion.id)).not.toBeNull();
  });

  it("extracts candidates and accepts one into a linked work order", async () => {
    const blueprint = store.createEntity({ type: "blueprint", title: "B", body: "## Approach\nbuild" });
    const extractApp = buildApi(store, {
      createProvider: () =>
        scriptedProvider("emit_work_orders", {
          candidates: [{ title: "Wire tools", body: "implement the three tools" }],
        }),
    });

    const extracted = await extractApp.request(`/entities/${blueprint.id}/extract`, { method: "POST" });
    const { candidates } = await json<{ candidates: { title: string; body: string }[] }>(extracted);
    expect(candidates.map((c) => c.title)).toEqual(["Wire tools"]);

    const accepted = await extractApp.request(`/entities/${blueprint.id}/work-orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(candidates[0]),
    });
    expect(accepted.status).toBe(201);
    const wo = await json<Entity>(accepted);
    expect(wo.type).toBe("work_order");
    expect(wo.status).toBe("draft");
    expect(store.linked(wo.id, "implements").map((e) => e.id)).toEqual([blueprint.id]);
  });

  it("returns 503 when the model provider cannot be constructed", async () => {
    const requirement = store.createEntity({ type: "requirement", title: "R" });
    const brokenApp = buildApi(store, {
      createProvider: () => {
        throw new Error("no API key in environment");
      },
    });

    const res = await brokenApp.request(`/entities/${requirement.id}/draft`, { method: "POST" });
    expect(res.status).toBe(503);
    expect((await json<{ error: string }>(res)).error).toContain("model provider unavailable");
  });

  it("returns 502 (not 500) when the model call fails at request time", async () => {
    const requirement = store.createEntity({ type: "requirement", title: "R" });
    // Provider constructs fine but fails on complete() — mirrors a missing key
    // that the Anthropic SDK only rejects when it actually calls the API.
    const failingApp = buildApi(store, {
      createProvider: () => ({
        async complete() {
          throw new Error("401 Could not resolve authentication method");
        },
      }),
    });

    const res = await failingApp.request(`/entities/${requirement.id}/draft`, { method: "POST" });
    expect(res.status).toBe(502);
    expect((await json<{ error: string }>(res)).error).toContain("authoring failed");
  });

  it("still 404s a draft against a missing entity", async () => {
    const failingApp = buildApi(store, {
      createProvider: () => ({
        async complete() {
          throw new Error("should not be reached");
        },
      }),
    });
    expect((await failingApp.request("/entities/nope/draft", { method: "POST" })).status).toBe(404);
  });

  it("serves context health and receipts read-only, without recording a receipt", async () => {
    const req = store.createEntity({ type: "requirement", title: "R", body: "intent" });
    const bp = store.createEntity({ type: "blueprint", title: "B", body: "approach" });
    const wo = store.createEntity({ type: "work_order", title: "W", body: "do it", status: "ready" });
    store.link(bp.id, req.id, "details");
    store.link(wo.id, bp.id, "implements");

    const health = await json<{ size: { chars: number; estTokens: number }; checks: { code: string; level: string }[] }>(
      await app.request(`/entities/${wo.id}/context/health`),
    );
    expect(health.size.estTokens).toBeGreaterThan(0);
    expect(health.checks.some((c) => c.code === "inherited-lineage")).toBe(true);

    // Seed a receipt, then read the history back.
    recordContextReceipt(store, wo.id);
    const receipts = await json<{ id: string; workOrderId: string; hash: string }[]>(
      await app.request(`/entities/${wo.id}/context/receipts`),
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0].workOrderId).toBe(wo.id);

    // Read-only: hitting either route does not create a receipt.
    const before = store.listContextReceipts(wo.id).length;
    await app.request(`/entities/${wo.id}/context/health`);
    await app.request(`/entities/${wo.id}/context/receipts`);
    expect(store.listContextReceipts(wo.id)).toHaveLength(before);
  });

  it("serves completion receipts, [] for ids without any", async () => {
    const req = store.createEntity({ type: "requirement", title: "R", body: "intent" });
    const wo = store.createEntity({ type: "work_order", title: "W", body: "do it", status: "done" });

    store.saveCompletionReceipt({
      id: "cr-1",
      workOrderId: wo.id,
      summary: "built it",
      verification: "tests green",
      commits: ["abc123"],
      branch: "main",
      filesTouched: ["src/a.ts"],
      createdAt: "2026-07-21T10:00:00.000Z",
    });

    const listed = await json<{ id: string; workOrderId: string; summary: string }[]>(
      await app.request(`/entities/${wo.id}/completion-receipts`),
    );
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: "cr-1", workOrderId: wo.id, summary: "built it" });

    // Consistent with /context/receipts: non-work-orders and unknown ids
    // simply have no receipts.
    expect(await json<unknown[]>(await app.request(`/entities/${req.id}/completion-receipts`))).toEqual([]);
    expect(await json<unknown[]>(await app.request(`/entities/nope/completion-receipts`))).toEqual([]);
  });

  it("gates draft→ready on completeness, with an explicit override", async () => {
    const bare = store.createEntity({ type: "work_order", title: "Bare", status: "draft", body: "just do it" });

    const refused = await app.request(`/entities/${bare.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "ready" }),
    });
    expect(refused.status).toBe(400);
    const err = (await json<{ error: string }>(refused)).error;
    expect(err).toContain("completeness gate");
    expect(err).toContain("missing-implements");
    expect(err).toContain("missing-acceptance-criteria");
    expect(err).toContain("overrideGate");
    expect(store.getEntity(bare.id)?.status).toBe("draft");

    // The explicit human override goes through.
    const overridden = await app.request(`/entities/${bare.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "ready", overrideGate: true }),
    });
    expect(overridden.status).toBe(200);
    expect((await json<Entity>(overridden)).status).toBe("ready");

    // Later transitions are not gated: ready→in_progress on the same bare WO.
    const claimed = await app.request(`/entities/${bare.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    });
    expect(claimed.status).toBe(200);
  });

  it("serves per-document health and 404s unknown ids", async () => {
    // A work order implementing a requirement directly is the degraded-context
    // bug the check exists for — it must surface as an error naming the target.
    const req = store.createEntity({ type: "requirement", title: "The req", body: "intent" });
    const wo = store.createEntity({ type: "work_order", title: "W", body: "do it" });
    store.link(wo.id, req.id, "implements");

    const health = await json<{ checks: { code: string; level: string; message: string }[] }>(
      await app.request(`/entities/${wo.id}/health`),
    );
    const err = health.checks.find((c) => c.code === "implements-not-blueprint");
    expect(err?.level).toBe("error");
    expect(err?.message).toContain('"The req"');

    expect((await app.request("/entities/nope/health")).status).toBe(404);
  });

  it("GET /graph returns the whole-graph snapshot shape", async () => {
    const art = store.createEntity({ type: "artifact", title: "Notes", body: "src" });
    const req = store.createEntity({ type: "requirement", title: "Feature" });
    const bp = store.createEntity({ type: "blueprint", title: "Design" });
    const wo = store.createEntity({ type: "work_order", title: "Build", status: "done" });
    store.link(req.id, art.id, "references");
    store.link(bp.id, req.id, "details");
    store.link(wo.id, bp.id, "implements");

    const body = await json<{
      nodes: { id: string; type: string; title: string; status: string | null; progress: number | null }[];
      edges: { fromId: string; toId: string; type: string }[];
    }>(await app.request("/graph"));

    expect(body.nodes.map((n) => n.id).sort()).toEqual([art.id, bp.id, req.id, wo.id].sort());
    // Blueprint rolls up its one done work order.
    expect(body.nodes.find((n) => n.id === bp.id)?.progress).toBe(1);
    expect(body.nodes.find((n) => n.id === art.id)?.progress).toBeNull();
    expect(body.edges).toContainEqual({ fromId: wo.id, toId: bp.id, type: "implements" });
  });

  it("serves X-ray overlays: gaps and critical path", async () => {
    // Complete chain + a gap blueprint; a two-deep dependency chain.
    const req = store.createEntity({ type: "requirement", title: "R" });
    const bp = store.createEntity({ type: "blueprint", title: "B" });
    store.link(bp.id, req.id, "details");
    const looseBp = store.createEntity({ type: "blueprint", title: "no wo" });
    const a = store.createEntity({ type: "work_order", title: "a", status: "ready" });
    const b = store.createEntity({ type: "work_order", title: "b", status: "ready" });
    store.link(a.id, bp.id, "implements");
    store.link(b.id, bp.id, "implements");
    store.link(a.id, b.id, "depends_on");

    const gaps = await json<{ requirements: string[]; blueprints: string[]; artifacts: string[] }>(
      await app.request("/graph/gaps"),
    );
    expect(gaps.blueprints).toContain(looseBp.id);
    expect(gaps.blueprints).not.toContain(bp.id);

    const crit = await json<{ path: string[] }>(await app.request("/graph/critical-path"));
    expect(crit.path).toEqual([a.id, b.id]);
  });

  it("GET /pulse returns the project health rollup", async () => {
    const req = store.createEntity({ type: "requirement", title: "Feature" });
    const bp = store.createEntity({ type: "blueprint", title: "Design" });
    store.link(bp.id, req.id, "details");
    // Second root keeps the store flat — a solo detailed root now reads as a
    // product root (childless-seeded-root fix), which would empty `features`.
    store.createEntity({ type: "requirement", title: "Sibling" });
    const done = store.createEntity({ type: "work_order", title: "shipped", status: "done" });
    const ready = store.createEntity({ type: "work_order", title: "next", status: "ready" });
    const doing = store.createEntity({ type: "work_order", title: "underway", status: "in_progress" });
    const stuck = store.createEntity({ type: "work_order", title: "stuck", status: "ready" });
    store.link(done.id, bp.id, "implements");
    store.link(ready.id, bp.id, "implements");
    store.link(ready.id, done.id, "depends_on"); // done dep: not blocked
    store.link(stuck.id, doing.id, "depends_on"); // unfinished dep: blocked

    const res = await app.request("/pulse");
    expect(res.status).toBe(200);
    const pulse = await json<{
      counts: Record<string, number>;
      workOrders: { total: number; byStatus: Record<string, number> };
      completion: number | null;
      features: { id: string; title: string; progress: number | null; blocked: number; gaps: number }[];
      criticalPath: { id: string }[];
      blocked: { id: string }[];
      now: { inProgress: { id: string }[]; next: { id: string }[] };
    }>(res);

    expect(pulse.counts.work_order).toBe(4);
    expect(pulse.workOrders.byStatus.done).toBe(1);
    expect(pulse.completion).toBe(0.25); // 1 done of 4 non-cancelled
    expect(pulse.features.map((f) => f.title)).toEqual(["Feature", "Sibling"]);
    expect(pulse.features[0].progress).toBe(0.5);
    // `now` flows through serialization: a ready-but-blocked work order lands
    // in `blocked`, NOT in `now.next` (the honest agent list).
    expect(pulse.now.inProgress.map((w) => w.id)).toEqual([doing.id]);
    expect(pulse.now.next.map((w) => w.id)).toEqual([ready.id]);
    expect(pulse.blocked.map((b) => b.id)).toEqual([stuck.id]);
    expect(pulse.criticalPath.map((p) => p.id)).toEqual([stuck.id, doing.id]);
  });

  it("GET /pulse/knowledge returns worst-first context health for active work orders", async () => {
    store.createEntity({ type: "work_order", title: "bare", status: "ready" }); // no bp/req: 2 warns
    store.createEntity({ type: "work_order", title: "finished", status: "done" }); // excluded

    const report = await json<{
      workOrders: { title: string; warns: number; checks: { code: string }[] }[];
      totals: { errors: number; warns: number; healthy: number };
    }>(await app.request("/pulse/knowledge"));

    expect(report.workOrders.map((w) => w.title)).toEqual(["bare"]);
    expect(report.workOrders[0].warns).toBe(2);
    expect(report.totals).toEqual({ errors: 0, warns: 2, healthy: 0 });
  });

  it("GET /pulse/activity honors ?limit and defaults without it", async () => {
    store.createEntity({ type: "artifact", title: "a" });
    store.createEntity({ type: "artifact", title: "b" });
    store.createEntity({ type: "artifact", title: "c" });

    const limited = await json<{ kind: string }[]>(await app.request("/pulse/activity?limit=2"));
    expect(limited).toHaveLength(2);

    const all = await json<{ kind: string }[]>(await app.request("/pulse/activity"));
    expect(all).toHaveLength(3);
    expect(all.every((e) => e.kind === "created")).toBe(true);
  });

  it("rejects junk or non-positive activity limits with 400", async () => {
    for (const limit of ["junk", "0", "-3", "1.5"]) {
      const res = await app.request(`/pulse/activity?limit=${limit}`);
      expect(res.status, `limit=${limit}`).toBe(400);
    }
  });

  it("pulse routes are read-only: no context receipts are recorded by viewing", async () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "ready" });
    await app.request("/pulse");
    await app.request("/pulse/knowledge");
    await app.request("/pulse/activity");
    expect(store.listContextReceipts(wo.id)).toEqual([]);
  });

  it("reports work-order readiness in bulk: blocked with blockers, unblocking when the dep goes done", async () => {
    const dep = store.createEntity({ type: "work_order", title: "Prereq", status: "in_progress" });
    const wo = store.createEntity({ type: "work_order", title: "Feature", status: "ready" });
    const solo = store.createEntity({ type: "work_order", title: "Standalone", status: "ready" });
    store.link(wo.id, dep.id, "depends_on");

    type Readiness = { id: string; blocked: boolean; blocking: { id: string; title: string; status: string | null }[] };
    let rows = await json<Readiness[]>(await app.request("/work-orders/readiness"));
    let byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(wo.id)).toEqual({
      id: wo.id,
      blocked: true,
      blocking: [{ id: dep.id, title: "Prereq", status: "in_progress" }],
    });
    expect(byId.get(solo.id)).toEqual({ id: solo.id, blocked: false, blocking: [] });

    // Finishing the dependency unblocks the dependent.
    store.updateEntity(dep.id, { status: "done" });
    rows = await json<Readiness[]>(await app.request("/work-orders/readiness"));
    byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(wo.id)).toEqual({ id: wo.id, blocked: false, blocking: [] });
  });

  // A provider that replays one scripted result (prose and/or a tool call), for
  // the refine chat route.
  function chatProvider(result: Partial<ModelResult>): { createProvider: () => ModelProvider } {
    return {
      createProvider: () => ({
        async complete() {
          return { text: "", toolCall: null, stopReason: "end_turn", model: "scripted", ...result };
        },
      }),
    };
  }

  const CHAT = (body: unknown) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  it("chat answers a question in prose without filing a suggestion", async () => {
    const req = store.createEntity({ type: "requirement", title: "R", body: "The audience is coding agents." });
    const chatApp = buildApi(store, chatProvider({ text: "It targets coding agents." }));

    const res = await chatApp.request(
      `/entities/${req.id}/chat`,
      CHAT({ messages: [{ role: "user", content: "Who is the audience?" }] }),
    );
    expect(res.status).toBe(200);
    const body = await json<{ reply: string; suggestionId?: string }>(res);
    expect(body.reply).toBe("It targets coding agents.");
    expect(body.suggestionId).toBeUndefined();
    expect(store.listSuggestions(req.id)).toHaveLength(0);
  });

  it("chat files a suggestion when the turn proposes an edit", async () => {
    const req = store.createEntity({ type: "requirement", title: "R", body: "anchored body" });
    const chatApp = buildApi(
      store,
      chatProvider({
        text: "Tightened it:",
        toolCall: { name: "emit_suggestion", input: { ops: [{ kind: "replace", anchor: "anchored body", text: "tighter body" }] } },
        stopReason: "tool_use",
      }),
    );

    const res = await chatApp.request(
      `/entities/${req.id}/chat`,
      CHAT({ messages: [{ role: "user", content: "Tighten it." }] }),
    );
    expect(res.status).toBe(200);
    const body = await json<{ reply: string; suggestionId?: string }>(res);
    expect(body.reply).toBe("Tightened it:");
    expect(body.suggestionId).toBeDefined();
    const saved = store.getSuggestion(body.suggestionId!);
    expect(saved?.source).toBe("refine_agent");
    expect(store.listSuggestions(req.id)).toHaveLength(1);
  });

  it("chat refuses to stack a second suggestion (anchor lock) with actionable 400 copy", async () => {
    const req = store.createEntity({ type: "requirement", title: "R", body: "anchored body" });
    // A suggestion is already pending on this document.
    store.saveSuggestion({
      id: "existing",
      targetId: req.id,
      source: "draft_agent",
      ops: [{ kind: "insert", anchor: "", text: "x" }],
    });
    const chatApp = buildApi(
      store,
      chatProvider({
        toolCall: { name: "emit_suggestion", input: { ops: [{ kind: "replace", anchor: "anchored body", text: "tighter" }] } },
        stopReason: "tool_use",
      }),
    );

    const res = await chatApp.request(
      `/entities/${req.id}/chat`,
      CHAT({ messages: [{ role: "user", content: "Change it." }] }),
    );
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toContain("already has a pending suggestion");
    // The second suggestion was not filed.
    expect(store.listSuggestions(req.id)).toHaveLength(1);
  });

  it("chat 400s a wrong-type target (only requirements and blueprints refine)", async () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "draft" });
    const chatApp = buildApi(store, chatProvider({ text: "hi" }));
    const res = await chatApp.request(
      `/entities/${wo.id}/chat`,
      CHAT({ messages: [{ role: "user", content: "hello" }] }),
    );
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toContain("only requirements and blueprints");
  });

  it("chat 503s when the provider is unavailable", async () => {
    const req = store.createEntity({ type: "requirement", title: "R" });
    const brokenApp = buildApi(store, {
      createProvider: () => {
        throw new Error("no API key in environment");
      },
    });
    const res = await brokenApp.request(
      `/entities/${req.id}/chat`,
      CHAT({ messages: [{ role: "user", content: "hi" }] }),
    );
    expect(res.status).toBe(503);
  });

  it("review returns findings + proposed ops without filing anything", async () => {
    const req = store.createEntity({ type: "requirement", title: "R", body: "delivered soon" });
    const reviewApp = buildApi(store, {
      createProvider: () =>
        scriptedProvider("emit_review", {
          findings: [{ severity: "major", kind: "ambiguity", note: "vague timing", quote: "soon" }],
          ops: [{ kind: "replace", anchor: "soon", text: "within one MCP call" }],
        }),
    });

    const res = await reviewApp.request(`/entities/${req.id}/review`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await json<{ findings: unknown[]; ops: unknown[] | null }>(res);
    expect(body.findings).toHaveLength(1);
    expect(body.ops).toHaveLength(1);
    // Nothing filed — the UI's "propose fixes" gates that through /suggestions.
    expect(store.listSuggestions(req.id)).toHaveLength(0);
  });

  it("review handles a clean document (no findings, no ops)", async () => {
    const req = store.createEntity({ type: "requirement", title: "R", body: "precise" });
    const reviewApp = buildApi(store, {
      createProvider: () => scriptedProvider("emit_review", { findings: [] }),
    });

    const body = await json<{ findings: unknown[]; ops: unknown[] | null }>(
      await reviewApp.request(`/entities/${req.id}/review`, { method: "POST" }),
    );
    expect(body).toEqual({ findings: [], ops: null });
  });

  it("review 400s a wrong-type target and 503s without a provider", async () => {
    const wo = store.createEntity({ type: "work_order", title: "W", status: "draft" });
    const reviewApp = buildApi(store, {
      createProvider: () => scriptedProvider("emit_review", { findings: [] }),
    });
    expect((await reviewApp.request(`/entities/${wo.id}/review`, { method: "POST" })).status).toBe(400);

    const req = store.createEntity({ type: "requirement", title: "R" });
    const brokenApp = buildApi(store, {
      createProvider: () => {
        throw new Error("no API key");
      },
    });
    expect((await brokenApp.request(`/entities/${req.id}/review`, { method: "POST" })).status).toBe(503);
  });

  it("POST /suggestions refuses to stack on a pending suggestion (anchor lock)", async () => {
    const req = store.createEntity({ type: "requirement", title: "R", body: "anchored" });
    const file = (ops: unknown) =>
      app.request("/suggestions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetId: req.id, source: "review_agent", ops }),
      });

    expect((await file([{ kind: "replace", anchor: "anchored", text: "first" }])).status).toBe(201);
    const second = await file([{ kind: "replace", anchor: "anchored", text: "second" }]);
    expect(second.status).toBe(400);
    expect((await json<{ error: string }>(second)).error).toContain("resolve pending suggestions first");
    expect(store.listSuggestions(req.id)).toHaveLength(1);
  });

  it("returns 400 with a message for invalid input", async () => {
    const badType = await app.request("/entities?type=widget");
    expect(badType.status).toBe(400);

    const badLink = await app.request("/links", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fromId: "a", toId: "b", type: "likes" }),
    });
    expect(badLink.status).toBe(400);
  });
});

describe("AI settings & usage", () => {
  const PUT = (body: unknown) => ({
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  interface AiSettings {
    provider: string;
    enabled: boolean;
    hasKey: boolean;
    keyTail: string | null;
  }

  // A scripted provider that also reports token usage, like the real one.
  function meteredProvider(name: string, input: unknown): ModelProvider {
    return {
      async complete(): Promise<ModelResult> {
        return {
          text: "",
          toolCall: { name, input },
          stopReason: "tool_use",
          model: "claude-haiku-4-5-20251001", // the SERVED (dated) id, as observed live
          usage: { inputTokens: 100, outputTokens: 25 },
        };
      },
    };
  }

  it("serves defaults for a fresh store", async () => {
    expect(await json<AiSettings>(await app.request("/settings/ai"))).toEqual({
      provider: "anthropic",
      enabled: true,
      hasKey: false,
      keyTail: null,
    });
  });

  it("sets, replaces, and removes the key — never echoing it back", async () => {
    const set = await app.request("/settings/ai", PUT({ apiKey: "sk-test-secret-abcd" }));
    expect(set.status).toBe(200);
    const afterSet = await json<AiSettings>(set);
    expect(afterSet).toMatchObject({ hasKey: true, keyTail: "abcd" });
    expect(JSON.stringify(afterSet)).not.toContain("sk-test-secret-abcd");

    const afterReplace = await json<AiSettings>(
      await app.request("/settings/ai", PUT({ apiKey: "sk-test-other-wxyz" })),
    );
    expect(afterReplace).toMatchObject({ hasKey: true, keyTail: "wxyz" });

    const afterRemove = await json<AiSettings>(await app.request("/settings/ai", PUT({ apiKey: null })));
    expect(afterRemove).toMatchObject({ hasKey: false, keyTail: null });

    // GET reflects the same masked view — and never the raw key.
    const got = await json<AiSettings>(await app.request("/settings/ai"));
    expect(JSON.stringify(got)).not.toContain("sk-test");
  });

  it("validates the PUT body at the Zod boundary", async () => {
    expect((await app.request("/settings/ai", PUT({ provider: "openai" }))).status).toBe(400);
    expect((await app.request("/settings/ai", PUT({ apiKey: "" }))).status).toBe(400);
  });

  it("toggles enabled and reflects it in /health.aiEnabled", async () => {
    const off = await json<AiSettings>(await app.request("/settings/ai", PUT({ enabled: false })));
    expect(off.enabled).toBe(false);
    expect(await json<{ aiEnabled: boolean }>(await app.request("/health"))).toMatchObject({ aiEnabled: false });

    const on = await json<AiSettings>(await app.request("/settings/ai", PUT({ enabled: true })));
    expect(on.enabled).toBe(true);
  });

  it("disabled AI → 503 with Settings copy on all four authoring routes, and no ledger rows", async () => {
    const req = store.createEntity({ type: "requirement", title: "R", body: "b" });
    const bp = store.createEntity({ type: "blueprint", title: "B", body: "## Approach\nx" });
    const aiApp = buildApi(store, { createProvider: () => meteredProvider("noop", {}) });
    await aiApp.request("/settings/ai", PUT({ enabled: false }));

    const attempts = [
      aiApp.request(`/entities/${req.id}/draft`, { method: "POST" }),
      aiApp.request(`/entities/${bp.id}/extract`, { method: "POST" }),
      aiApp.request(`/entities/${req.id}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
      aiApp.request(`/entities/${req.id}/review`, { method: "POST" }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(503);
      expect((await json<{ error: string }>(res)).error).toContain("disabled in Settings");
    }
    expect(store.listModelUsage()).toEqual([]);
  });

  it("records usage per feature on each authoring route", async () => {
    const req = store.createEntity({ type: "requirement", title: "R", body: "anchored body" });
    const bp = store.createEntity({ type: "blueprint", title: "B", body: "## Approach\nx" });

    const draftApp = buildApi(store, {
      createProvider: () =>
        meteredProvider("emit_suggestion", { ops: [{ kind: "insert", anchor: "", text: "drafted" }] }),
    });
    await draftApp.request(`/entities/${req.id}/draft`, { method: "POST" });
    // dismiss the filed suggestion so later routes aren't anchor-locked
    for (const s of store.listSuggestions(req.id)) store.deleteSuggestion(s.id);

    const extractApp = buildApi(store, {
      createProvider: () => meteredProvider("emit_work_orders", { candidates: [{ title: "T", body: "b" }] }),
    });
    await extractApp.request(`/entities/${bp.id}/extract`, { method: "POST" });

    const chatApp = buildApi(store, {
      createProvider: () => ({
        async complete(): Promise<ModelResult> {
          return {
            text: "answered",
            toolCall: null,
            stopReason: "end_turn",
            model: "claude-haiku-4-5-20251001",
            usage: { inputTokens: 100, outputTokens: 25 },
          };
        },
      }),
    });
    await chatApp.request(`/entities/${req.id}/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    const reviewApp = buildApi(store, {
      createProvider: () => meteredProvider("emit_review", { findings: [] }),
    });
    await reviewApp.request(`/entities/${req.id}/review`, { method: "POST" });

    const entries = store.listModelUsage();
    expect(entries.map((e) => e.feature)).toEqual(["draft", "extract", "chat", "review"]);
    for (const e of entries) {
      expect(e.model).toBe("claude-haiku-4-5-20251001");
      expect(e.inputTokens).toBe(100);
      expect(e.outputTokens).toBe(25);
    }
  });

  it("serves the usage report over the ledger — priced via the served-id prefix", async () => {
    const req = store.createEntity({ type: "requirement", title: "R", body: "b" });
    const draftApp = buildApi(store, {
      createProvider: () =>
        meteredProvider("emit_suggestion", { ops: [{ kind: "insert", anchor: "", text: "drafted" }] }),
    });
    await draftApp.request(`/entities/${req.id}/draft`, { method: "POST" });

    const report = await json<{
      totals: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number | null };
      costIsPartial: boolean;
      byDay: unknown[];
      byFeature: { feature: string; totalTokens: number }[];
      byModel: { model: string }[];
    }>(await app.request("/usage"));

    expect(report.totals).toMatchObject({ inputTokens: 100, outputTokens: 25, totalTokens: 125 });
    expect(report.costIsPartial).toBe(false); // dated haiku id priced by prefix
    expect(report.totals.estimatedCostUsd).toBeGreaterThan(0);
    expect(report.byDay).toHaveLength(30);
    expect(report.byFeature.find((f) => f.feature === "draft")?.totalTokens).toBe(125);
    expect(report.byModel.map((m) => m.model)).toEqual(["claude-haiku-4-5-20251001"]);
  });

  it("resolves the provider settings-first, env-fallback (providerForKey seam)", async () => {
    const observed: (string | null)[] = [];
    const resolvingApp = buildApi(store, {
      providerForKey: (apiKey) => {
        observed.push(apiKey);
        return meteredProvider("emit_review", { findings: [] });
      },
    });
    const req = store.createEntity({ type: "requirement", title: "R", body: "b" });

    await resolvingApp.request("/settings/ai", PUT({ apiKey: "sk-settings-key-1234" }));
    await resolvingApp.request(`/entities/${req.id}/review`, { method: "POST" });
    await resolvingApp.request("/settings/ai", PUT({ apiKey: null }));
    await resolvingApp.request(`/entities/${req.id}/review`, { method: "POST" });

    // stored key wins; removing it falls back to the env-resolved path (null)
    expect(observed).toEqual(["sk-settings-key-1234", null]);
  });

  it("default provider path: a settings key makes the provider constructible without env credentials", async () => {
    const saved: Record<string, string | undefined> = {};
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    try {
      const realApp = buildApi(store); // real providerForKey — construct-only, no model call
      expect(await json<{ providerAvailable: boolean }>(await realApp.request("/health"))).toMatchObject({
        providerAvailable: false,
      });

      await realApp.request("/settings/ai", PUT({ apiKey: "sk-test-from-settings" }));
      expect(await json<{ providerAvailable: boolean }>(await realApp.request("/health"))).toMatchObject({
        providerAvailable: true,
      });

      await realApp.request("/settings/ai", PUT({ apiKey: null }));
      expect(await json<{ providerAvailable: boolean }>(await realApp.request("/health"))).toMatchObject({
        providerAvailable: false,
      });
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value !== undefined) process.env[key] = value;
      }
    }
  });
});

describe("authoring-skills settings (settings documents)", () => {
  const PUT = (body: unknown) => ({
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const doc = (id: string, title: string, enabled = true) => ({
    id,
    title,
    body: `${title} body`,
    enabled,
  });

  it("GET returns an empty array for a fresh store", async () => {
    expect(await json(await app.request("/settings/authoring-skills"))).toEqual([]);
  });

  it("PUT persists full documents and GET round-trips order and enabled flags", async () => {
    const docs = [doc("a", "Style guide"), doc("b", "Terminology", false)];
    const put = await app.request("/settings/authoring-skills", PUT(docs));
    expect(put.status).toBe(200);
    expect(await json(put)).toEqual(docs);
    expect(await json(await app.request("/settings/authoring-skills"))).toEqual(docs);
  });

  it("PUT dedupes repeated ids, first occurrence winning", async () => {
    const res = await app.request(
      "/settings/authoring-skills",
      PUT([doc("a", "First"), doc("b", "Other"), doc("a", "Second")]),
    );
    expect((await json<{ title: string }[]>(res)).map((d) => d.title)).toEqual(["First", "Other"]);
  });

  it("PUT rejects non-array bodies and malformed documents", async () => {
    expect((await app.request("/settings/authoring-skills", PUT({ docs: [] }))).status).toBe(400);
    expect(
      (await app.request("/settings/authoring-skills", PUT([{ id: "a", title: "No enabled", body: "" }]))).status,
    ).toBe(400);
    expect(
      (await app.request("/settings/authoring-skills", PUT([{ id: "", title: "T", body: "", enabled: true }]))).status,
    ).toBe(400);
  });

  it("GET reads a malformed or legacy stored value as empty", async () => {
    store.setSetting("kiln.authoring.skills", "not json");
    expect(await json(await app.request("/settings/authoring-skills"))).toEqual([]);
    store.setSetting("kiln.authoring.skills", JSON.stringify(["legacy-artifact-id"]));
    expect(await json(await app.request("/settings/authoring-skills"))).toEqual([]);
  });
});

describe("authoring-skills flow-through to agent calls", () => {
  const PUT = (body: unknown) => ({
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const POST = (body: unknown) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  // Records every request so tests can assert what system prompt was sent.
  function recordingProvider(result: Partial<ModelResult>): {
    provider: ModelProvider;
    requests: Parameters<ModelProvider["complete"]>[0][];
  } {
    const requests: Parameters<ModelProvider["complete"]>[0][] = [];
    const provider: ModelProvider = {
      async complete(req): Promise<ModelResult> {
        requests.push(req);
        return { text: "", toolCall: null, stopReason: "end_turn", model: "scripted", ...result };
      },
    };
    return { provider, requests };
  }

  it("chat carries enabled skills, ignores disabled ones, and none when empty", async () => {
    const docEntity = store.createEntity({ type: "requirement", title: "Feature", body: "A body." });
    const { provider, requests } = recordingProvider({ text: "hello" });
    const chatApp = buildApi(store, { createProvider: () => provider });

    // Empty set: no skills section.
    await chatApp.request(`/entities/${docEntity.id}/chat`, POST({ messages: [{ role: "user", content: "hi" }] }));
    expect(requests[0].system).not.toContain("Authoring skills");

    // One enabled + one disabled skill: only the enabled body appears.
    await chatApp.request(
      "/settings/authoring-skills",
      PUT([
        { id: "on", title: "Terse blueprints", body: "Blueprints never exceed 300 words.", enabled: true },
        { id: "off", title: "Disabled rule", body: "NEVER-SEEN-TEXT", enabled: false },
      ]),
    );
    await chatApp.request(`/entities/${docEntity.id}/chat`, POST({ messages: [{ role: "user", content: "hi" }] }));
    expect(requests[1].system).toContain("Authoring skills (house standards — follow these):");
    expect(requests[1].system).toContain("Blueprints never exceed 300 words.");
    expect(requests[1].system).not.toContain("NEVER-SEEN-TEXT");
  });

  it("draft applies an enabled skill's template override for the target type", async () => {
    const docEntity = store.createEntity({ type: "requirement", title: "Feature", body: "" });
    const { provider, requests } = recordingProvider({
      toolCall: {
        name: "emit_suggestion",
        input: { ops: [{ kind: "insert", anchor: "", text: "## Problem\ndrafted" }] },
      },
      stopReason: "tool_use",
    });
    const draftApp = buildApi(store, { createProvider: () => provider });
    await draftApp.request(
      "/settings/authoring-skills",
      PUT([
        {
          id: "tpl",
          title: "Org requirement shape",
          body: "## Template: requirement\n\n```\n## Problem\n<p>\n\n## Done when\n<d>\n```",
          enabled: true,
        },
      ]),
    );

    const res = await draftApp.request(`/entities/${docEntity.id}/draft`, POST({}));
    expect(res.status).toBe(200);
    expect(requests[0].system).toContain("## Problem");
    expect(requests[0].system).toContain("## Done when");
    expect(requests[0].system).not.toContain("## Capability");
  });
});
