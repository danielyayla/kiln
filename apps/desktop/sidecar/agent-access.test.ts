import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createProject, NotFoundError, SqliteStore, type Store } from "@kiln/core";
import {
  agentAccessConfigPath,
  createAgentAccess,
  DEFAULT_AGENT_PORT,
  readAgentAccessConfig,
  writeAgentAccessConfig,
  type AgentAccess,
} from "./agent-access.js";

const home = join(tmpdir(), `kiln-sidecar-agent-access-test-${process.pid}`);

// Every opened store is tracked so tests can assert the dedicated handle is
// closed on disable/pin — the seam projects.ts also exposes.
let opened: { dbPath: string; closed: boolean }[] = [];
const trackingOpenStore = (dbPath: string): Store => {
  const real = new SqliteStore(dbPath);
  const record = { dbPath, closed: false };
  opened.push(record);
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "close") {
        return () => {
          record.closed = true;
          target.close();
        };
      }
      const value = target[prop as keyof Store];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

let access: AgentAccess | null = null;

beforeEach(() => {
  mkdirSync(home, { recursive: true });
  opened = [];
});
afterEach(async () => {
  await access?.close();
  access = null;
  rmSync(home, { recursive: true, force: true });
});

// A registered project with one ready work order, so the served entities are
// observable through the MCP tools.
function project(name: string, workOrderTitle: string): { id: string } {
  const entry = createProject(name, { home });
  const store = new SqliteStore(entry.dbPath);
  try {
    store.createEntity({ type: "work_order", title: workOrderTitle, status: "ready" });
  } finally {
    store.close();
  }
  return { id: entry.id };
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const initBody = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
});

async function post(endpoint: string, token?: string): Promise<{ status: number }> {
  return rpc(endpoint, token ?? null, JSON.parse(initBody));
}

// Un-pooled JSON-RPC POST. The SDK client (used once below to prove real-MCP
// compatibility) rides the process-global fetch pool, which hands back a
// destroyed socket right after a listener restart — a test-client artifact,
// not server behavior. agent: false opens a fresh connection per request, so
// across-restart assertions stay deterministic.
function rpc(endpoint: string, token: string | null, body: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(
      endpoint,
      {
        method: "POST",
        agent: false,
        headers: {
          ...mcpHeaders,
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

// The stateless server handles each POST with a fresh transport, so a direct
// tools/call needs no initialize handshake. Responses arrive as SSE frames.
async function listReadyTitles(endpoint: string, token: string): Promise<string[]> {
  const { status, text } = await rpc(endpoint, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "list_ready_work_orders", arguments: {} },
  });
  expect(status).toBe(200);
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  const parsed = JSON.parse(dataLine ? dataLine.slice(5) : text) as {
    result?: { structuredContent?: { workOrders: { title: string }[] } };
  };
  return (parsed.result?.structuredContent?.workOrders ?? []).map((w) => w.title);
}

async function enabledAccess(projectId: string): Promise<{ access: AgentAccess; endpoint: string; token: string }> {
  const port = await freePort();
  writeAgentAccessConfig({ enabled: false, port, token: "", projectId }, home);
  access = createAgentAccess({ home, openStore: trackingOpenStore });
  const status = await access.enable();
  expect(status.running).toBe(true);
  expect(status.error).toBeNull();
  return { access, endpoint: status.endpoint, token: status.token };
}

describe("agent access config", () => {
  it("round-trips through the module and creates the file 0600", () => {
    const config = { enabled: true, port: 5000, token: "t0ken", projectId: "p1" };
    writeAgentAccessConfig(config, home);

    expect(readAgentAccessConfig(home)).toEqual({ config, error: null });
    expect(statSync(agentAccessConfigPath(home)).mode & 0o777).toBe(0o600);
  });

  it("reads a missing file as disabled defaults without error", () => {
    const { config, error } = readAgentAccessConfig(home);
    expect(config).toEqual({ enabled: false, port: DEFAULT_AGENT_PORT, token: "", projectId: null });
    expect(error).toBeNull();
  });

  it("reads a corrupt file as disabled and surfaces the parse error in status()", () => {
    writeFileSync(agentAccessConfigPath(home), "{not json", "utf8");
    access = createAgentAccess({ home });

    const status = access.status();
    expect(status.enabled).toBe(false);
    expect(status.running).toBe(false);
    expect(status.error).toContain("agent-access.json is invalid");
  });
});

describe("enable/disable lifecycle", () => {
  it("enable() serves the Kiln tools to a real streamable-HTTP MCP client; wrong or missing token gets 401", async () => {
    const { id } = project("Alpha", "alpha ready wo");
    const { endpoint, token } = await enabledAccess(id);

    expect((await post(endpoint, token)).status).toBe(200);
    expect((await post(endpoint, "wrong")).status).toBe(401);
    expect((await post(endpoint)).status).toBe(401);
    expect((await post(endpoint, "")).status).toBe(401);

    const client = new Client({ name: "tools-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("list_ready_work_orders");
      expect(tools.map((t) => t.name)).toContain("get_work_order");
    } finally {
      await client.close();
    }
  });

  it("enable() generates and persists a token when the config has none", async () => {
    const { id } = project("Alpha", "wo");
    const { token } = await enabledAccess(id);

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readAgentAccessConfig(home).config.token).toBe(token);
  });

  it("serves the pinned project's entities from a dedicated store", async () => {
    const { id } = project("Alpha", "alpha ready wo");
    const { endpoint, token } = await enabledAccess(id);

    expect(await listReadyTitles(endpoint, token)).toEqual(["alpha ready wo"]);
  });

  it("enable() without a pin falls back to the registry default and persists it", async () => {
    const { id } = project("Alpha", "wo"); // createProject promotes first project to default
    const port = await freePort();
    writeAgentAccessConfig({ enabled: false, port, token: "", projectId: null }, home);
    access = createAgentAccess({ home, openStore: trackingOpenStore });

    const status = await access.enable();
    expect(status.running).toBe(true);
    expect(status.project?.id).toBe(id);
    expect(readAgentAccessConfig(home).config.projectId).toBe(id);
  });

  it("enable() with no pin and no registry stays stopped with an actionable error", async () => {
    const port = await freePort();
    writeAgentAccessConfig({ enabled: false, port, token: "", projectId: null }, home);
    access = createAgentAccess({ home });

    const status = await access.enable();
    expect(status.running).toBe(false);
    expect(status.error).toContain("no project pinned");
  });

  it("disable() stops the listener and closes the dedicated store", async () => {
    const { id } = project("Alpha", "wo");
    const { access: a, endpoint, token } = await enabledAccess(id);

    const status = await a.disable();
    expect(status.running).toBe(false);
    expect(status.enabled).toBe(false);
    await expect(post(endpoint, token)).rejects.toThrow(); // connection refused
    expect(opened).toHaveLength(1);
    expect(opened[0].closed).toBe(true);
  });
});

describe("regenerateToken", () => {
  it("invalidates the previous token on the very next request", async () => {
    const { id } = project("Alpha", "wo");
    const { access: a, endpoint, token: oldToken } = await enabledAccess(id);

    const status = await a.regenerateToken();
    expect(status.token).not.toBe(oldToken);
    expect((await post(endpoint, oldToken)).status).toBe(401);
    expect((await post(endpoint, status.token)).status).toBe(200);
  });
});

describe("pin", () => {
  it("swaps to the other project's store (old handle closed) and the served entities change", async () => {
    const alpha = project("Alpha", "alpha ready wo");
    const beta = project("Beta", "beta ready wo");
    const { access: a, endpoint, token } = await enabledAccess(alpha.id);
    expect(await listReadyTitles(endpoint, token)).toEqual(["alpha ready wo"]);

    const status = await a.pin(beta.id);
    expect(status.running).toBe(true);
    expect(status.project?.id).toBe(beta.id);
    expect(await listReadyTitles(endpoint, token)).toEqual(["beta ready wo"]);

    expect(opened).toHaveLength(2);
    expect(opened[0].closed).toBe(true);
    expect(opened[1].closed).toBe(false);
  });

  it("pinning an unregistered project is a typed error and changes nothing", async () => {
    const alpha = project("Alpha", "alpha ready wo");
    const { access: a, endpoint, token } = await enabledAccess(alpha.id);

    await expect(a.pin("nope")).rejects.toThrow(NotFoundError);
    expect(a.status().project?.id).toBe(alpha.id);
    expect(readAgentAccessConfig(home).config.projectId).toBe(alpha.id);
    expect(await listReadyTitles(endpoint, token)).toEqual(["alpha ready wo"]);
  });
});

describe("boot wiring", () => {
  it("boot() with a persisted enabled config serves MCP without any API call", async () => {
    const { id } = project("Alpha", "alpha ready wo");
    const port = await freePort();
    const token = "a".repeat(64);
    writeAgentAccessConfig({ enabled: true, port, token, projectId: id }, home);
    access = createAgentAccess({ home, openStore: trackingOpenStore });

    await access.boot();
    const status = access.status();
    expect(status.running).toBe(true);
    expect(await listReadyTitles(status.endpoint, token)).toEqual(["alpha ready wo"]);
  });

  it("boot() with a disabled config starts nothing", async () => {
    const { id } = project("Alpha", "wo");
    const port = await freePort();
    writeAgentAccessConfig({ enabled: false, port, token: "t", projectId: id }, home);
    access = createAgentAccess({ home, openStore: trackingOpenStore });

    await access.boot();
    expect(access.status().running).toBe(false);
    expect(opened).toHaveLength(0);
  });

  it("close() after boot stops the listener and closes the dedicated store, leaving config untouched", async () => {
    const { id } = project("Alpha", "wo");
    const port = await freePort();
    const token = "b".repeat(64);
    writeAgentAccessConfig({ enabled: true, port, token, projectId: id }, home);
    access = createAgentAccess({ home, openStore: trackingOpenStore });
    await access.boot();

    await access.close();
    await expect(post(access.status().endpoint, token)).rejects.toThrow(); // connection refused
    expect(opened).toHaveLength(1);
    expect(opened[0].closed).toBe(true);
    expect(readAgentAccessConfig(home).config.enabled).toBe(true); // shutdown ≠ disable
  });
});

describe("projectRemoved", () => {
  it("disables loudly when the pin is removed; other removals are ignored", async () => {
    const { id } = project("Alpha", "alpha ready wo");
    const { access: a, endpoint, token } = await enabledAccess(id);

    await a.projectRemoved("someone-else", "Other");
    expect(a.status().running).toBe(true);

    await a.projectRemoved(id, "Alpha");
    const status = a.status();
    expect(status.enabled).toBe(false);
    expect(status.running).toBe(false);
    expect(status.error).toContain('"Alpha"');
    expect(readAgentAccessConfig(home).config).toMatchObject({ enabled: false, projectId: null });
    await expect(post(endpoint, token)).rejects.toThrow();
  });
});

describe("bind failure", () => {
  let blocker: Server;
  afterEach(() => new Promise<void>((resolve) => blocker.close(() => resolve())));

  it("a port already in use yields running: false and a status error naming the port — no throw", async () => {
    const { id } = project("Alpha", "wo");
    const port = await freePort();
    blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(port, "127.0.0.1", resolve));

    writeAgentAccessConfig({ enabled: false, port, token: "", projectId: id }, home);
    access = createAgentAccess({ home, openStore: trackingOpenStore });

    const status = await access.enable();
    expect(status.running).toBe(false);
    expect(status.enabled).toBe(true);
    expect(status.error).toContain(String(port));
    // The store opened for the failed bind is not leaked.
    expect(opened.every((s) => s.closed)).toBe(true);
  });
});
