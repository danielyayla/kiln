import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DESIGN_DOC_TEMPLATE, seedProject, SqliteStore } from "@kiln/core";
import { buildMcpServer } from "./server.js";
import { seed, type SeededChain } from "./seed.js";

let store: SqliteStore;
let client: Client;
let chain: SeededChain;

beforeEach(async () => {
  store = new SqliteStore(":memory:");
  chain = seed(store);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildMcpServer(store);
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await client.close();
  store.close();
});

describe("MCP tools", () => {
  it("lists all six tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_project_shape",
      "get_work_order",
      "list_ready_work_orders",
      "propose_feature",
      "propose_root_overview",
      "update_work_order_status",
    ]);
  });

  it("list_ready_work_orders returns the ready work order with a summary", async () => {
    const res = await client.callTool({ name: "list_ready_work_orders", arguments: {} });
    expect(res.isError).toBeFalsy();
    const { workOrders } = res.structuredContent as {
      workOrders: { id: string; title: string; summary: string }[];
    };
    expect(workOrders).toHaveLength(1);
    expect(workOrders[0].id).toBe(chain.workOrderId);
    expect(workOrders[0].summary.length).toBeGreaterThan(0);
  });

  it("get_work_order returns the full assembled context", async () => {
    const res = await client.callTool({
      name: "get_work_order",
      arguments: { id: chain.workOrderId },
    });
    expect(res.isError).toBeFalsy();
    const ctx = res.structuredContent as {
      workOrder: { id: string };
      blueprint: { id: string } | null;
      requirement: { id: string } | null;
      artifacts: { id: string }[];
      dependencies: { id: string; title: string; status: string | null }[];
      lineage: unknown[];
    };
    expect(ctx.workOrder.id).toBe(chain.workOrderId);
    expect(ctx.blueprint?.id).toBe(chain.blueprintId);
    expect(ctx.requirement?.id).toBe(chain.requirementId);
    expect(ctx.artifacts.map((a) => a.id)).toEqual([chain.artifactId]);
    // The seeded primary work order declares no dependencies.
    expect(ctx.dependencies).toEqual([]);
    // Its requirement is a root — no inherited lineage.
    expect(ctx.lineage).toEqual([]);
  });

  it("get_work_order carries workType and per-type guidance (BP-18)", async () => {
    const wo = store.createEntity({ type: "work_order", title: "Fix the leak", workType: "bug", status: "ready" });
    const res = await client.callTool({ name: "get_work_order", arguments: { id: wo.id } });
    expect(res.isError).toBeFalsy();
    const ctx = res.structuredContent as { workOrder: { workType: string | null }; workType: string; guidance: string };
    expect(ctx.workOrder.workType).toBe("bug");
    expect(ctx.workType).toBe("bug");
    expect(ctx.guidance).toContain("regression test");

    // An untyped work order resolves to feature with feature guidance.
    const plain = res.isError ? null : await client.callTool({ name: "get_work_order", arguments: { id: chain.workOrderId } });
    const plainCtx = plain!.structuredContent as { workType: string; guidance: string };
    expect(plainCtx.workType).toBe("feature");
    expect(plainCtx.guidance.length).toBeGreaterThan(0);
  });

  it("get_work_order surfaces ancestor lineage for a nested work order", async () => {
    // root(Root PRD, Root arch BP) <- leaf(Leaf spec) ; blueprint details leaf.
    const aRoot = store.createEntity({ type: "artifact", title: "Root PRD", body: "why" });
    const aLeaf = store.createEntity({ type: "artifact", title: "Leaf spec", body: "leaf" });
    const root = store.createEntity({ type: "requirement", title: "root req" });
    const rootBp = store.createEntity({ type: "blueprint", title: "Root architecture", body: "how" });
    const leaf = store.createEntity({ type: "requirement", title: "leaf req" });
    const bp = store.createEntity({ type: "blueprint", title: "Nested BP" });
    const wo = store.createEntity({ type: "work_order", title: "nested WO", status: "ready" });
    store.link(leaf.id, root.id, "child_of");
    store.link(root.id, aRoot.id, "references");
    store.link(rootBp.id, root.id, "details");
    store.link(leaf.id, aLeaf.id, "references");
    store.link(bp.id, leaf.id, "details");
    store.link(wo.id, bp.id, "implements");

    const res = await client.callTool({ name: "get_work_order", arguments: { id: wo.id } });
    expect(res.isError).toBeFalsy();
    const ctx = res.structuredContent as {
      artifacts: { id: string }[];
      lineage: {
        requirement: { id: string; title: string };
        artifacts: { id: string }[];
        blueprint?: { id: string };
      }[];
    };
    // Own artifacts unchanged; the root's artifact arrives via lineage.
    expect(ctx.artifacts.map((a) => a.id)).toEqual([aLeaf.id]);
    expect(ctx.lineage).toHaveLength(1);
    expect(ctx.lineage[0].requirement.id).toBe(root.id);
    expect(ctx.lineage[0].artifacts.map((a) => a.id)).toEqual([aRoot.id]);
    // The root's details blueprint rides the lineage (Phase 14).
    expect(ctx.lineage[0].blueprint?.id).toBe(rootBp.id);
  });

  it("get_work_order records a deduplicated context receipt on each handoff", async () => {
    const call = () => client.callTool({ name: "get_work_order", arguments: { id: chain.workOrderId } });

    await call();
    expect(store.listContextReceipts(chain.workOrderId)).toHaveLength(1);

    await call(); // identical context → deduped, no new receipt
    expect(store.listContextReceipts(chain.workOrderId)).toHaveLength(1);

    // Change the assembled context (edit the requirement), then a new handoff records.
    store.updateEntity(chain.requirementId, { body: "clarified intent" });
    await call();
    expect(store.listContextReceipts(chain.workOrderId)).toHaveLength(2);
  });

  it("recording a receipt leaves the get_work_order payload unchanged", async () => {
    const res = await client.callTool({ name: "get_work_order", arguments: { id: chain.workOrderId } });
    // Exactly the assembled-context payload — no receipt fields leak in.
    expect(Object.keys(res.structuredContent as object).sort()).toEqual(
      ["artifacts", "blueprint", "dependencies", "guidance", "lineage", "requirement", "workOrder", "workType"].sort(),
    );
  });

  it("get_work_order reports depends_on dependencies with their statuses", async () => {
    // Give the ready work order an unfinished prerequisite.
    const prereq = store.createEntity({
      type: "work_order",
      title: "Prerequisite work",
      body: "Must finish first.",
      status: "in_progress",
    });
    store.link(chain.workOrderId, prereq.id, "depends_on");

    const res = await client.callTool({
      name: "get_work_order",
      arguments: { id: chain.workOrderId },
    });
    expect(res.isError).toBeFalsy();
    const { dependencies } = res.structuredContent as {
      dependencies: { id: string; title: string; status: string | null }[];
    };
    expect(dependencies).toEqual([{ id: prereq.id, title: "Prerequisite work", status: "in_progress" }]);
  });

  it("list_ready_work_orders withholds a ready work order that is blocked, then offers it once unblocked", async () => {
    // Block the one ready work order on an unfinished prerequisite.
    const prereq = store.createEntity({
      type: "work_order",
      title: "Prerequisite work",
      body: "Must finish first.",
      status: "ready",
    });
    store.link(chain.workOrderId, prereq.id, "depends_on");

    // The dependent is withheld; only the (unblocked) prerequisite is offered.
    let res = await client.callTool({ name: "list_ready_work_orders", arguments: {} });
    let ids = (res.structuredContent as { workOrders: { id: string }[] }).workOrders.map((w) => w.id);
    expect(ids).toEqual([prereq.id]);

    // Finish the prerequisite; the dependent unblocks and the prereq leaves `ready`.
    store.updateEntity(prereq.id, { status: "in_progress" });
    store.updateEntity(prereq.id, { status: "done" });

    res = await client.callTool({ name: "list_ready_work_orders", arguments: {} });
    ids = (res.structuredContent as { workOrders: { id: string }[] }).workOrders.map((w) => w.id);
    expect(ids).toEqual([chain.workOrderId]);
  });

  it("get_work_order reports a clear error for an unknown id", async () => {
    const res = await client.callTool({ name: "get_work_order", arguments: { id: "nope" } });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain("not found");
  });

  it("update_work_order_status advances through the lifecycle", async () => {
    const res = await client.callTool({
      name: "update_work_order_status",
      arguments: { id: chain.workOrderId, status: "in_progress" },
    });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { workOrder: { status: string } }).workOrder.status).toBe(
      "in_progress",
    );
    expect(store.getEntity(chain.workOrderId)?.status).toBe("in_progress");
  });

  it("update_work_order_status rejects an invalid transition", async () => {
    // ready → done skips in_progress and must be refused.
    const res = await client.callTool({
      name: "update_work_order_status",
      arguments: { id: chain.workOrderId, status: "done" },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain("Invalid status transition");
    // Store is unchanged.
    expect(store.getEntity(chain.workOrderId)?.status).toBe("ready");
  });

  it("update_work_order_status refuses draft→ready on an incomplete work order (no override over MCP)", async () => {
    const bare = store.createEntity({ type: "work_order", title: "Bare", status: "draft", body: "just do it" });
    const res = await client.callTool({
      name: "update_work_order_status",
      arguments: { id: bare.id, status: "ready" },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toContain("completeness gate");
    expect(text).toContain("missing-implements");
    expect(store.getEntity(bare.id)?.status).toBe("draft");
  });

  it("update_work_order_status rejects an invalid status value at the schema boundary", async () => {
    const res = await client.callTool({
      name: "update_work_order_status",
      arguments: { id: chain.workOrderId, status: "banana" },
    });
    expect(res.isError).toBe(true);
  });

  it("update_work_order_status refuses in_progress → done without a completion report", async () => {
    store.updateEntity(chain.workOrderId, { status: "in_progress" });
    const res = await client.callTool({
      name: "update_work_order_status",
      arguments: { id: chain.workOrderId, status: "done" },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toContain("report.summary");
    expect(text).toContain("report.verification");
    expect(store.getEntity(chain.workOrderId)?.status).toBe("in_progress");
    expect(store.listCompletionReceipts(chain.workOrderId)).toEqual([]);
  });

  it("update_work_order_status closes with a report, records exactly one receipt, and returns its id", async () => {
    store.updateEntity(chain.workOrderId, { status: "in_progress" });
    const report = {
      summary: "Implemented the completion-report requirement.",
      verification: "pnpm -C packages/mcp-server test — all green.",
      commits: ["abc1234"],
      branch: "main",
      filesTouched: ["packages/mcp-server/src/tools.ts"],
    };
    const res = await client.callTool({
      name: "update_work_order_status",
      arguments: { id: chain.workOrderId, status: "done", report },
    });
    expect(res.isError).toBeFalsy();
    const { workOrder, completionReceiptId } = res.structuredContent as {
      workOrder: { status: string };
      completionReceiptId: string;
    };
    expect(workOrder.status).toBe("done");
    expect(completionReceiptId).toBeTruthy();
    expect(store.getEntity(chain.workOrderId)?.status).toBe("done");
    // Exactly one receipt, its fields round-tripped verbatim.
    const receipts = store.listCompletionReceipts(chain.workOrderId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      id: completionReceiptId,
      workOrderId: chain.workOrderId,
      ...report,
    });
  });

  it("update_work_order_status accepts a minimal report and defaults the testimony fields", async () => {
    store.updateEntity(chain.workOrderId, { status: "in_progress" });
    const res = await client.callTool({
      name: "update_work_order_status",
      arguments: {
        id: chain.workOrderId,
        status: "done",
        report: { summary: "Built it.", verification: "Verified live." },
      },
    });
    expect(res.isError).toBeFalsy();
    const [receipt] = store.listCompletionReceipts(chain.workOrderId);
    expect(receipt.commits).toEqual([]);
    expect(receipt.filesTouched).toEqual([]);
    expect(receipt.branch).toBeUndefined();
  });

  it("update_work_order_status rejects a report on any other transition and writes no receipt", async () => {
    // ready → in_progress is legal, but a report does not belong on it.
    const res = await client.callTool({
      name: "update_work_order_status",
      arguments: {
        id: chain.workOrderId,
        status: "in_progress",
        report: { summary: "premature", verification: "n/a" },
      },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain(
      "only accepted when closing in_progress → done",
    );
    expect(store.getEntity(chain.workOrderId)?.status).toBe("ready");
    expect(store.listCompletionReceipts(chain.workOrderId)).toEqual([]);
  });

  it("update_work_order_status surfaces core validation of a blank-field report", async () => {
    // "   " passes the schema boundary's min(1); core's whitespace rule rejects it.
    store.updateEntity(chain.workOrderId, { status: "in_progress" });
    const res = await client.callTool({
      name: "update_work_order_status",
      arguments: {
        id: chain.workOrderId,
        status: "done",
        report: { summary: "   ", verification: "Tested." },
      },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain("report.summary");
    expect(store.getEntity(chain.workOrderId)?.status).toBe("in_progress");
    expect(store.listCompletionReceipts(chain.workOrderId)).toEqual([]);
  });

  it("update_work_order_status keeps the status when the receipt write fails", async () => {
    store.updateEntity(chain.workOrderId, { status: "in_progress" });
    vi.spyOn(store, "saveCompletionReceipt").mockImplementation(() => {
      throw new Error("simulated receipt write failure");
    });
    const res = await client.callTool({
      name: "update_work_order_status",
      arguments: {
        id: chain.workOrderId,
        status: "done",
        report: { summary: "Built it.", verification: "Tested." },
      },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain("status unchanged");
    expect(store.getEntity(chain.workOrderId)?.status).toBe("in_progress");
    vi.restoreAllMocks();
    expect(store.listCompletionReceipts(chain.workOrderId)).toEqual([]);
  });
});

describe("propose_feature", () => {
  const proposal = () => ({
    requirement: {
      title: "Search — find any document instantly",
      body: "## Capability\nFull-text search.\n\n## Non-goals\n- No fuzzy matching.",
    },
    blueprint: { title: "BP — Search", body: "## Approach\nSQLite FTS5 behind the Store." },
    evidence: [{ title: "src/search.ts excerpt", body: "export function search() {}" }],
  });

  // Everything a rejection must leave untouched: entity ids per type plus the
  // link and suggestion counts.
  const snapshot = () => ({
    requirements: store.listEntities("requirement").map((e) => e.id).sort(),
    blueprints: store.listEntities("blueprint").map((e) => e.id).sort(),
    artifacts: store.listEntities("artifact").map((e) => e.id).sort(),
    workOrders: store.listEntities("work_order").map((e) => e.id).sort(),
    links: store.listLinks().length,
  });

  const call = (args: Record<string, unknown>) =>
    client.callTool({ name: "propose_feature", arguments: args });

  const errorText = (res: Awaited<ReturnType<typeof call>>) =>
    (res.content as { text: string }[])[0].text;

  it("creates the full gated shape under an explicit parent and returns every id", async () => {
    const res = await call({ ...proposal(), parentRequirementId: chain.requirementId });
    expect(res.isError).toBeFalsy();
    const ids = res.structuredContent as {
      requirementId: string;
      blueprintId: string;
      artifactIds: string[];
      suggestionIds: string[];
    };

    const requirement = store.getEntity(ids.requirementId)!;
    const blueprint = store.getEntity(ids.blueprintId)!;
    expect(requirement.type).toBe("requirement");
    expect(blueprint.type).toBe("blueprint");
    // The gate property: nothing is committed — bodies stay empty, the
    // proposed text is a pending suggestion, and no revision exists.
    expect(requirement.body).toBe("");
    expect(blueprint.body).toBe("");
    expect(store.listRevisions(ids.requirementId)).toEqual([]);
    expect(store.listRevisions(ids.blueprintId)).toEqual([]);

    expect(store.linked(ids.requirementId, "child_of").map((e) => e.id)).toEqual([chain.requirementId]);
    expect(store.linked(ids.blueprintId, "details").map((e) => e.id)).toEqual([ids.requirementId]);
    expect(store.linked(ids.requirementId, "references").map((e) => e.id)).toEqual(ids.artifactIds);

    // Evidence is ungated source material — its body lands directly.
    expect(ids.artifactIds).toHaveLength(1);
    expect(store.getEntity(ids.artifactIds[0])!.body).toBe("export function search() {}");

    expect(ids.suggestionIds).toHaveLength(2);
    const [reqSuggestion] = store.listSuggestions(ids.requirementId);
    const [bpSuggestion] = store.listSuggestions(ids.blueprintId);
    expect(reqSuggestion.id).toBe(ids.suggestionIds[0]);
    expect(bpSuggestion.id).toBe(ids.suggestionIds[1]);
    for (const [suggestion, body] of [
      [reqSuggestion, proposal().requirement.body],
      [bpSuggestion, proposal().blueprint.body],
    ] as const) {
      expect(suggestion.source).toBe("extract_agent");
      expect(suggestion.ops).toEqual([{ kind: "insert", anchor: "", text: body }]);
    }
  });

  it("resolves the single parentless root when parentRequirementId is omitted", async () => {
    // Collapse the seeded store's two roots into one tree.
    const [rootA, rootB] = store
      .listEntities("requirement")
      .filter((r) => store.linked(r.id, "child_of").length === 0);
    store.link(rootB.id, rootA.id, "child_of");

    const res = await call(proposal());
    expect(res.isError).toBeFalsy();
    const { requirementId } = res.structuredContent as { requirementId: string };
    expect(store.linked(requirementId, "child_of").map((e) => e.id)).toEqual([rootA.id]);
  });

  it("rejects a missing product root loudly", async () => {
    const empty = new SqliteStore(":memory:");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const emptyClient = new Client({ name: "test-client-2", version: "0.0.0" });
    await Promise.all([
      buildMcpServer(empty).connect(serverTransport),
      emptyClient.connect(clientTransport),
    ]);
    try {
      const res = await emptyClient.callTool({ name: "propose_feature", arguments: proposal() });
      expect(res.isError).toBe(true);
      expect((res.content as { text: string }[])[0].text).toContain("No product root");
      expect(empty.listEntities("requirement")).toEqual([]);
    } finally {
      await emptyClient.close();
      empty.close();
    }
  });

  it("rejects an ambiguous product root loudly", async () => {
    // The seeded store has two parentless requirements.
    const before = snapshot();
    const res = await call(proposal());
    expect(res.isError).toBe(true);
    expect(errorText(res)).toContain("Ambiguous product root");
    expect(snapshot()).toEqual(before);
  });

  it("rejects a parent that is missing or not a requirement, writing nothing", async () => {
    const before = snapshot();

    let res = await call({ ...proposal(), parentRequirementId: "nope" });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toContain("Parent requirement not found");

    res = await call({ ...proposal(), parentRequirementId: chain.blueprintId });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toContain("not a requirement");

    expect(snapshot()).toEqual(before);
  });

  it("rejects a malformed payload at the schema boundary", async () => {
    const { requirement: _dropped, ...withoutRequirement } = proposal();
    const res = await call(withoutRequirement);
    expect(res.isError).toBe(true);
  });

  it("rejects blank fields naming the offending document, writing nothing", async () => {
    const before = snapshot();
    const bad = proposal();
    bad.blueprint.body = "   \n\t";
    const res = await call({ ...bad, parentRequirementId: chain.requirementId });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toContain("blueprint: body is empty or whitespace-only");
    expect(snapshot()).toEqual(before);
  });

  it("rejects an oversized body naming the document and the cap", async () => {
    const before = snapshot();
    const bad = proposal();
    bad.requirement.body = `## Non-goals\n${"x".repeat(20_001)}`;
    const res = await call({ ...bad, parentRequirementId: chain.requirementId });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toContain("requirement: body exceeds 20000 characters");
    expect(snapshot()).toEqual(before);
  });

  it("rejects an empty and an over-cap evidence list", async () => {
    const before = snapshot();

    let res = await call({ ...proposal(), evidence: [], parentRequirementId: chain.requirementId });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toContain("at least one evidence artifact");

    const many = Array.from({ length: 21 }, (_, i) => ({ title: `e${i}`, body: "b" }));
    res = await call({ ...proposal(), evidence: many, parentRequirementId: chain.requirementId });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toContain("exceed the cap of 20");

    expect(snapshot()).toEqual(before);
  });

  it("rejects a requirement body failing the blocking health rules (missing-non-goals)", async () => {
    const before = snapshot();
    const bad = proposal();
    bad.requirement.body = "## Capability\nSearch, but no non-goals section.";
    const res = await call({ ...bad, parentRequirementId: chain.requirementId });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toContain("missing-non-goals");
    expect(snapshot()).toEqual(before);
  });

  it("enforces the feature-title-shape rule only under the product root", async () => {
    const bad = proposal();
    bad.requirement.title = "Search";

    // Seeded store: two roots, parent given explicitly — the rule is off.
    let res = await call({ ...bad, parentRequirementId: chain.requirementId });
    expect(res.isError).toBeFalsy();

    // Collapse to a single root: proposing under it now demands the shape.
    const roots = store
      .listEntities("requirement")
      .filter((r) => store.linked(r.id, "child_of").length === 0);
    for (const extra of roots.slice(1)) store.link(extra.id, roots[0].id, "child_of");
    const before = snapshot();
    res = await call({ ...bad, parentRequirementId: roots[0].id });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toContain("feature-title-shape");
    expect(snapshot()).toEqual(before);
  });
});

describe("propose_root_overview", () => {
  // A fresh-project store, seeded exactly the way `kiln projects create` and
  // the app's New Project seed it: root requirement (empty body) + design-doc
  // blueprint (the fill-in template), linked details → root.
  let fresh: SqliteStore;
  let freshClient: Client;
  let root: { id: string };
  let designDoc: { id: string };

  beforeEach(async () => {
    fresh = new SqliteStore(":memory:");
    ({ root, designDoc } = seedProject(fresh, "Demo"));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    freshClient = new Client({ name: "test-client-root", version: "0.0.0" });
    await Promise.all([
      buildMcpServer(fresh).connect(serverTransport),
      freshClient.connect(clientTransport),
    ]);
  });

  afterEach(async () => {
    await freshClient.close();
    fresh.close();
  });

  const rootProposal = () => ({
    overview: "## Overview\nA demo product.\n\n## Non-goals\n- Not a toy.",
    architecture: "## Components\nOne binary talking to one database.",
    evidence: [{ title: "README excerpt", body: "Demo does demo things." }],
  });

  const call = (args: Record<string, unknown>) =>
    freshClient.callTool({ name: "propose_root_overview", arguments: args });

  const errorText = (res: Awaited<ReturnType<typeof call>>) =>
    (res.content as { text: string }[])[0].text;

  it("files both root suggestions and the evidence, committing nothing", async () => {
    const res = await call(rootProposal());
    expect(res.isError).toBeFalsy();
    const ids = res.structuredContent as {
      rootRequirementId: string;
      blueprintId: string;
      artifactIds: string[];
      suggestionIds: string[];
    };
    expect(ids.rootRequirementId).toBe(root.id);
    expect(ids.blueprintId).toBe(designDoc.id);

    // The gate property: bodies and titles untouched, no revisions.
    expect(fresh.getEntity(root.id)!.body).toBe("");
    expect(fresh.getEntity(root.id)!.title).toBe("Demo");
    expect(fresh.getEntity(designDoc.id)!.body).toBe(DESIGN_DOC_TEMPLATE);
    expect(fresh.listRevisions(root.id)).toEqual([]);
    expect(fresh.listRevisions(designDoc.id)).toEqual([]);

    // Overview → empty-anchor insert on the empty root; architecture →
    // whole-body replace over the seeded template.
    const [overviewSuggestion] = fresh.listSuggestions(root.id);
    expect(overviewSuggestion.id).toBe(ids.suggestionIds[0]);
    expect(overviewSuggestion.ops).toEqual([
      { kind: "insert", anchor: "", text: rootProposal().overview },
    ]);
    const [architectureSuggestion] = fresh.listSuggestions(designDoc.id);
    expect(architectureSuggestion.id).toBe(ids.suggestionIds[1]);
    expect(architectureSuggestion.ops).toEqual([
      { kind: "replace", anchor: DESIGN_DOC_TEMPLATE, text: rootProposal().architecture },
    ]);

    // Evidence is ungated, references-linked from the root.
    expect(ids.artifactIds).toHaveLength(1);
    expect(fresh.linked(root.id, "references").map((e) => e.id)).toEqual(ids.artifactIds);
  });

  it("evidence is optional", async () => {
    const { evidence: _none, ...bare } = rootProposal();
    const res = await call(bare);
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { artifactIds: string[] }).artifactIds).toEqual([]);
  });

  it("refuses a non-empty root body loudly, writing nothing", async () => {
    fresh.updateEntity(root.id, { body: "A hand-written overview." });
    const res = await call(rootProposal());
    expect(res.isError).toBe(true);
    expect(errorText(res)).toContain("non-empty body");
    expect(fresh.listSuggestions(root.id)).toEqual([]);
    expect(fresh.listEntities("artifact")).toEqual([]);
  });

  it("refuses an edited architecture template loudly", async () => {
    fresh.updateEntity(designDoc.id, { body: `${DESIGN_DOC_TEMPLATE}\nedited` });
    const res = await call(rootProposal());
    expect(res.isError).toBe(true);
    expect(errorText(res)).toContain("edited since seeding");
    expect(fresh.listSuggestions(root.id)).toEqual([]);
  });

  it("refuses to stack on a pending proposal (anchor lock)", async () => {
    expect((await call(rootProposal())).isError).toBeFalsy();
    const res = await call(rootProposal());
    expect(res.isError).toBe(true);
    expect(errorText(res)).toContain("pending suggestion");
    expect(fresh.listSuggestions(root.id)).toHaveLength(1);
    expect(fresh.listSuggestions(designDoc.id)).toHaveLength(1);
    expect(fresh.listEntities("artifact")).toHaveLength(1);
  });

  it("collects document failures together, naming each check", async () => {
    const res = await call({
      overview: "## Overview\nNo non-goals here.",
      architecture: "x".repeat(20_001),
      evidence: [{ title: " ", body: "b" }],
    });
    expect(res.isError).toBe(true);
    const text = errorText(res);
    expect(text).toContain("overview: no Non-goals section (missing-non-goals)");
    expect(text).toContain("architecture: body exceeds 20000 characters");
    expect(text).toContain("evidence[0]: title is empty or whitespace-only");
    expect(fresh.listSuggestions(root.id)).toEqual([]);
    expect(fresh.listEntities("artifact")).toEqual([]);
  });

  it("rejects an ambiguous product root (the seeded demo store has two)", async () => {
    const res = await client.callTool({
      name: "propose_root_overview",
      arguments: rootProposal(),
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain("Ambiguous product root");
  });

  it("rejects a root without a details blueprint", async () => {
    fresh.deleteEntity(designDoc.id);
    const res = await call(rootProposal());
    expect(res.isError).toBe(true);
    expect(errorText(res)).toContain("no details blueprint");
  });
});

describe("get_project_shape", () => {
  // Each shape gets its own store + in-memory client, mirroring the fresh-store
  // setup propose_root_overview uses.
  const openClient = async (s: SqliteStore) => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "test-client-shape", version: "0.0.0" });
    await Promise.all([buildMcpServer(s).connect(serverTransport), c.connect(clientTransport)]);
    return c;
  };

  const shapeOf = async (c: Client) => {
    const res = await c.callTool({ name: "get_project_shape", arguments: {} });
    expect(res.isError).toBeFalsy();
    return res.structuredContent as {
      shape: string;
      rootTitle: string | null;
      counts: { requirements: number; blueprints: number; workOrders: number; artifacts: number };
      pendingSuggestions: number;
    };
  };

  it("reports an unseeded store as empty", async () => {
    const s = new SqliteStore(":memory:");
    const c = await openClient(s);
    try {
      expect(await shapeOf(c)).toEqual({
        shape: "empty",
        rootTitle: null,
        counts: { requirements: 0, blueprints: 0, workOrders: 0, artifacts: 0 },
        pendingSuggestions: 0,
      });
    } finally {
      await c.close();
      s.close();
    }
  });

  it("reports a fresh-seeded project as fresh with its root title", async () => {
    const s = new SqliteStore(":memory:");
    seedProject(s, "Demo");
    const c = await openClient(s);
    try {
      expect(await shapeOf(c)).toEqual({
        shape: "fresh",
        rootTitle: "Demo",
        counts: { requirements: 1, blueprints: 1, workOrders: 0, artifacts: 0 },
        pendingSuggestions: 0,
      });
    } finally {
      await c.close();
      s.close();
    }
  });

  it("reports the seeded demo chain as populated — even with zero ready work orders", async () => {
    // Drain readiness: the fresh/populated distinction must not depend on it.
    store.updateEntity(chain.workOrderId, { status: "cancelled" });
    const list = await client.callTool({ name: "list_ready_work_orders", arguments: {} });
    expect((list.structuredContent as { workOrders: unknown[] }).workOrders).toEqual([]);

    const shape = await shapeOf(client);
    expect(shape.shape).toBe("populated");
    expect(shape.counts.workOrders).toBeGreaterThan(0);
  });
});
