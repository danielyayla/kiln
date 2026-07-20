import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "@kiln/core";
import type { ModelProvider, ModelResult } from "@kiln/agents";
import { buildMcpServer } from "@kiln/mcp-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  runAccept,
  runCreate,
  runDraft,
  runExtract,
  runLink,
  runSetStatus,
} from "./commands.js";

// The WO-12 acceptance: a scripted run authors a requirement, drafts a
// blueprint, extracts a work order, sets it ready — and it appears in
// list_ready_work_orders over MCP, read by a SEPARATE store on the same
// SQLite file (exactly how the real MCP server shares the database).
// Model calls are scripted; everything else is real.

function scriptedProvider(responses: Array<{ name: string; input: unknown }>): ModelProvider {
  let call = 0;
  return {
    async complete(): Promise<ModelResult> {
      const r = responses[Math.min(call++, responses.length - 1)];
      return { text: "", toolCall: r, stopReason: "tool_use", model: "scripted" };
    },
  };
}

let dir: string;
let store: SqliteStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kiln-cli-e2e-"));
  store = new SqliteStore(join(dir, "kiln.db"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("scripted headless run (WO-12 acceptance)", () => {
  it("author → draft → extract → ready → visible over MCP", async () => {
    // 1. Author: source artifact + requirement, drafted from the artifact.
    const artifact = runCreate(store, "artifact", "Kickoff transcript", "Users lose the intent thread.");
    const requirement = runCreate(store, "requirement", "Traceable handoff");
    runLink(store, requirement.id, artifact.id, "references");

    const reqDraft = await runDraft(
      store,
      scriptedProvider([
        {
          name: "emit_suggestion",
          input: {
            ops: [
              {
                kind: "insert",
                anchor: "",
                text: "## User story\nAs a builder, I want traceable handoff.\n\n## Acceptance criteria\n- Full context in one call",
              },
            ],
          },
        },
      ]),
      requirement.id,
    );
    runAccept(store, reqDraft.id);
    expect(store.getEntity(requirement.id)?.body).toContain("## User story");

    // 2. Draft a blueprint detailing the requirement.
    const blueprint = runCreate(store, "blueprint", "MCP bridge blueprint");
    runLink(store, blueprint.id, requirement.id, "details");

    const bpDraft = await runDraft(
      store,
      scriptedProvider([
        {
          name: "emit_suggestion",
          input: {
            ops: [
              {
                kind: "insert",
                anchor: "",
                text: "## Approach\nServe ready work orders over MCP.\n\n## Components\n- bridge: expose tools\n\n## Risks\n- auth drift: pin SDK",
              },
            ],
          },
        },
      ]),
      blueprint.id,
    );
    runAccept(store, bpDraft.id);

    // 3. Extract a work order from the blueprint and accept it.
    const { accepted } = await runExtract(
      store,
      scriptedProvider([
        {
          name: "emit_work_orders",
          input: {
            // Methodology-shaped candidate body: the extracted work order must
            // pass the draft→ready completeness gate at step 4.
            candidates: [
              {
                title: "Wire the MCP tools",
                body: "## Scope\nImplement the three tools over Store.\n\n## Acceptance criteria\n- [ ] all three tools answer over MCP",
              },
            ],
          },
        },
      ]),
      blueprint.id,
      "all",
    );
    expect(accepted).toHaveLength(1);
    const workOrder = accepted[0];
    expect(workOrder.status).toBe("draft");

    // 4. Set it ready.
    runSetStatus(store, workOrder.id, "ready");

    // 5. A separate store on the same file (as the real MCP server would
    //    open) serves it over MCP with the full assembled context.
    const serverStore = new SqliteStore(join(dir, "kiln.db"));
    const client = new Client({ name: "e2e", version: "0.0.0" });
    try {
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([buildMcpServer(serverStore).connect(st), client.connect(ct)]);

      const list = await client.callTool({ name: "list_ready_work_orders", arguments: {} });
      const { workOrders } = list.structuredContent as { workOrders: { id: string; title: string }[] };
      expect(workOrders.map((w) => w.id)).toEqual([workOrder.id]);

      const got = await client.callTool({ name: "get_work_order", arguments: { id: workOrder.id } });
      const ctx = got.structuredContent as {
        blueprint: { id: string } | null;
        requirement: { id: string } | null;
        artifacts: { id: string }[];
      };
      expect(ctx.blueprint?.id).toBe(blueprint.id);
      expect(ctx.requirement?.id).toBe(requirement.id);
      expect(ctx.artifacts.map((a) => a.id)).toEqual([artifact.id]);
    } finally {
      await client.close();
      serverStore.close();
    }
  });
});
