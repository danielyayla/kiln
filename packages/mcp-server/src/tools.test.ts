import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SqliteStore } from "@kiln/core";
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
  await client.close();
  store.close();
});

describe("MCP tools", () => {
  it("lists all three tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_work_order",
      "list_ready_work_orders",
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
      ["artifacts", "blueprint", "dependencies", "lineage", "requirement", "workOrder"].sort(),
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
});
