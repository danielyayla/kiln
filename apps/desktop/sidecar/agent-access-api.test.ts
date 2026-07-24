import { createServer, request as httpRequest } from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProject, SqliteStore } from "@kiln/core";
import { buildApi } from "./api.js";
import { createAgentAccess, writeAgentAccessConfig, type AgentAccess, type AgentAccessStatus } from "./agent-access.js";
import { createProjectManager, type ProjectManager } from "./projects.js";

// Route tests for the agent-access control surface on the app-private API.
// The full listener lifecycle is covered in agent-access.test.ts at the
// manager seam; here the assertions run through the HTTP routes the Settings
// UI calls, against a REAL listener and a real project manager, so the pin /
// no-yank / disable-loudly semantics are proven end to end.

const home = join(tmpdir(), `kiln-sidecar-agent-access-api-test-${process.pid}`);

let manager: ProjectManager;
let access: AgentAccess;
let app: ReturnType<typeof buildApi>;

beforeEach(() => {
  mkdirSync(home, { recursive: true });
  // The manager boots FIRST on the empty home, adopting the legacy
  // <home>/kiln.db as "My project" (active AND default) — projects created
  // afterwards are never the app's active one, the shape the no-yank
  // assertions need.
  manager = createProjectManager({ env: {}, home });
});
afterEach(async () => {
  await access.close();
  manager.close();
  rmSync(home, { recursive: true, force: true });
});

// A registered project with one ready work order, so what the MCP endpoint
// serves is observable per project.
function project(name: string, workOrderTitle: string): { id: string; name: string } {
  const entry = createProject(name, { home });
  const store = new SqliteStore(entry.dbPath);
  try {
    store.createEntity({ type: "work_order", title: workOrderTitle, status: "ready" });
  } finally {
    store.close();
  }
  return { id: entry.id, name: entry.name };
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

// Un-pooled JSON-RPC POST (see agent-access.test.ts): fresh socket per
// request keeps across-restart assertions deterministic.
function rpc(endpoint: string, token: string | null, body: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest(
      endpoint,
      {
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
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

async function json<T>(res: Response, status = 200): Promise<T> {
  expect(res.status).toBe(status);
  return (await res.json()) as T;
}

const getStatus = async (): Promise<AgentAccessStatus> =>
  json<AgentAccessStatus>(await app.request("/agent-access"));

const put = (body: unknown) =>
  app.request("/agent-access", {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

// Arm the rest of the stack the way server.ts wires it — manager + access
// into buildApi — with the config pre-pinned to a project on a known-free
// port.
async function arm(pinnedId: string): Promise<void> {
  const port = await freePort();
  writeAgentAccessConfig({ enabled: false, port, token: "", projectId: pinnedId }, home);
  access = createAgentAccess({ home });
  app = buildApi(manager.store, { projects: manager, agentAccess: access });
}

describe("agent-access routes", () => {
  it("GET returns the full status object — project as public info, no dbPath anywhere", async () => {
    const alpha = project("Alpha", "alpha wo");
    await arm(alpha.id);

    const status = await getStatus();
    expect(status).toEqual({
      enabled: false,
      running: false,
      port: expect.any(Number),
      endpoint: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
      token: "",
      project: { id: alpha.id, name: "Alpha" },
      error: null,
    });
    const raw = JSON.stringify(status);
    expect(raw).not.toContain("dbPath");
    expect(raw).not.toContain(home);
  });

  it("PUT {enabled: true} starts serving MCP (token in full); {enabled: false} refuses connections", async () => {
    const alpha = project("Alpha", "alpha ready wo");
    await arm(alpha.id);

    const enabled = await json<AgentAccessStatus>(await put({ enabled: true }));
    expect(enabled.running).toBe(true);
    expect(enabled.token).toMatch(/^[0-9a-f]{64}$/);
    expect(await listReadyTitles(enabled.endpoint, enabled.token)).toEqual(["alpha ready wo"]);

    const disabled = await json<AgentAccessStatus>(await put({ enabled: false }));
    expect(disabled.running).toBe(false);
    await expect(listReadyTitles(enabled.endpoint, enabled.token)).rejects.toThrow(); // connection refused
  });

  it("regenerate-token makes the old token 401 on the very next request", async () => {
    const alpha = project("Alpha", "wo");
    await arm(alpha.id);
    const { endpoint, token: oldToken } = await json<AgentAccessStatus>(await put({ enabled: true }));

    const status = await json<AgentAccessStatus>(
      await app.request("/agent-access/regenerate-token", { method: "POST" }),
    );
    expect(status.token).not.toBe(oldToken);
    const init = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_ready_work_orders", arguments: {} } };
    expect((await rpc(endpoint, oldToken, init)).status).toBe(401);
    expect((await rpc(endpoint, status.token, init)).status).toBe(200);
  });

  it("pin switches which project the endpoint serves; the app's active store is untouched", async () => {
    const alpha = project("Alpha", "alpha ready wo");
    const beta = project("Beta", "beta ready wo");
    await arm(alpha.id);
    const { endpoint, token } = await json<AgentAccessStatus>(await put({ enabled: true }));
    expect(await listReadyTitles(endpoint, token)).toEqual(["alpha ready wo"]);

    const status = await json<AgentAccessStatus>(
      await app.request("/agent-access/pin", {
        method: "POST",
        body: JSON.stringify({ projectId: beta.id }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(status.project).toEqual({ id: beta.id, name: "Beta" });
    expect(await listReadyTitles(endpoint, token)).toEqual(["beta ready wo"]);

    // The app's active store is still "My project" (empty), before and after.
    const active = await json<{ activeProject: string | null; projects: { id: string; name: string }[] }>(
      await app.request("/projects"),
    );
    const activeName = active.projects.find((p) => p.id === active.activeProject)?.name;
    expect(activeName).toBe("My project");
    expect(await json<unknown[]>(await app.request("/entities?status=ready"))).toEqual([]);
  });

  it("invalid input is a typed error and changes nothing", async () => {
    const alpha = project("Alpha", "alpha ready wo");
    await arm(alpha.id);
    const { endpoint, token } = await json<AgentAccessStatus>(await put({ enabled: true }));
    const before = await getStatus();

    // Bad port (out of range, wrong type) — 400, nothing changed.
    expect(await json<{ error: string }>(await put({ port: 0 }), 400)).toHaveProperty("error");
    expect(await json<{ error: string }>(await put({ port: "high" }), 400)).toHaveProperty("error");
    // Unknown projectId — 404, still serving Alpha.
    expect(
      await json<{ error: string }>(
        await app.request("/agent-access/pin", {
          method: "POST",
          body: JSON.stringify({ projectId: "ghost" }),
          headers: { "content-type": "application/json" },
        }),
        404,
      ),
    ).toHaveProperty("error");
    // Malformed body — the typed error shape, nothing changed.
    const malformed = await app.request("/agent-access", {
      method: "PUT",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    expect(malformed.status).toBeGreaterThanOrEqual(400);
    expect(await malformed.json()).toHaveProperty("error");

    expect(await getStatus()).toEqual(before);
    expect(await listReadyTitles(endpoint, token)).toEqual(["alpha ready wo"]);
  });

  it("removing the pinned project via the projects routes disables agent access loudly", async () => {
    const alpha = project("Alpha", "alpha ready wo");
    await arm(alpha.id);
    const { endpoint, token } = await json<AgentAccessStatus>(await put({ enabled: true }));

    await json<{ ok: boolean }>(await app.request(`/projects/${alpha.id}`, { method: "DELETE" }));

    const status = await getStatus();
    expect(status.enabled).toBe(false);
    expect(status.running).toBe(false);
    expect(status.error).toContain('"Alpha"');
    expect(status.error).toContain("removed");
    await expect(listReadyTitles(endpoint, token)).rejects.toThrow(); // connection refused
  });

  it("removing a non-pinned project leaves agent access untouched", async () => {
    const alpha = project("Alpha", "alpha ready wo");
    const beta = project("Beta", "beta wo");
    await arm(alpha.id);
    const { endpoint, token } = await json<AgentAccessStatus>(await put({ enabled: true }));

    await json<{ ok: boolean }>(await app.request(`/projects/${beta.id}`, { method: "DELETE" }));

    const status = await getStatus();
    expect(status.enabled).toBe(true);
    expect(status.running).toBe(true);
    expect(await listReadyTitles(endpoint, token)).toEqual(["alpha ready wo"]);
  });

  it("PUT with a new port rebinds a running listener; old port refuses", async () => {
    const alpha = project("Alpha", "alpha ready wo");
    await arm(alpha.id);
    const first = await json<AgentAccessStatus>(await put({ enabled: true }));
    const nextPort = await freePort();

    const status = await json<AgentAccessStatus>(await put({ port: nextPort }));
    expect(status.running).toBe(true);
    expect(status.port).toBe(nextPort);
    expect(await listReadyTitles(status.endpoint, status.token)).toEqual(["alpha ready wo"]);
    await expect(listReadyTitles(first.endpoint, first.token)).rejects.toThrow();
  });
});
