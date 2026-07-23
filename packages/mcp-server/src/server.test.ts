import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SqliteStore } from "@kiln/core";
import { createKilnHttpServer } from "./server.js";
import { seed } from "./seed.js";

const TOKEN = "test-secret-token";

let store: SqliteStore;
let httpServer: Server;
let baseUrl: string;

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

beforeEach(async () => {
  store = new SqliteStore(":memory:");
  seed(store);
  httpServer = createKilnHttpServer({ store, token: TOKEN });
  await listen(httpServer);
  const { port } = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/mcp`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  store.close();
});

const initBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
});

const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };

describe("HTTP bearer auth", () => {
  it("refuses calls with no Authorization header", async () => {
    const res = await fetch(baseUrl, { method: "POST", headers: mcpHeaders, body: initBody });
    expect(res.status).toBe(401);
  });

  it("refuses calls with the wrong token", async () => {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { ...mcpHeaders, authorization: "Bearer wrong" },
      body: initBody,
    });
    expect(res.status).toBe(401);
  });

  it("accepts an initialize call with the correct token", async () => {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { ...mcpHeaders, authorization: `Bearer ${TOKEN}` },
      body: initBody,
    });
    expect(res.status).toBe(200);
  });
});

describe("streamable HTTP MCP client", () => {
  it("connects with a bearer token and lists the six tools", async () => {
    const client = new Client({ name: "http-test-client", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "get_project_shape",
        "get_work_order",
        "list_ready_work_orders",
        "propose_feature",
        "propose_root_overview",
        "update_work_order_status",
      ]);
    } finally {
      await client.close();
    }
  });

  it("rejects a client that presents no token", async () => {
    const client = new Client({ name: "noauth-client", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl));
    await expect(client.connect(transport)).rejects.toThrow();
  });
});
