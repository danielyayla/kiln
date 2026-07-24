import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { z } from "zod";
import {
  defaultKilnHome,
  NotFoundError,
  readRegistry,
  SqliteStore,
  type Store,
} from "@kiln/core";
// NB: the sidecar bundle aliases this package to its src/server.ts (see
// tsup.config.ts) — the dist index is also the `kiln-mcp` CLI, and its
// run-when-main guard misfires once inlined into the bundle.
import { createKilnHttpServer } from "@kiln/mcp-server";

// Agent access (bundled MCP server feature): the sidecar hosts the unmodified
// @kiln/mcp-server bridge on its own localhost port, driven by an app-level
// config file beside the project registry. The listener serves a DEDICATED
// SqliteStore opened on the pinned project's dbPath — never the app's
// active-store proxy — so switching projects in the app can never yank a
// connected agent (the no-yank guarantee, implemented structurally).

export const DEFAULT_AGENT_PORT = 4824;
const ENDPOINT = "/mcp";
// The trust boundary in one constant: the endpoint is bearer-authed and handed
// to third-party processes, but only ever on loopback. No config path may
// widen this in v1.
const HOST = "127.0.0.1";

// The config file is an untrusted boundary (hand-editable), like the registry:
// reads validate with Zod and any failure reads as disabled-with-error, never
// a crash.
export const AgentAccessConfigSchema = z.object({
  enabled: z.boolean().default(false),
  port: z.number().int().min(1).max(65535).default(DEFAULT_AGENT_PORT),
  token: z.string().default(""),
  projectId: z.string().nullable().default(null),
});
export type AgentAccessConfig = z.infer<typeof AgentAccessConfigSchema>;

const DISABLED: AgentAccessConfig = {
  enabled: false,
  port: DEFAULT_AGENT_PORT,
  token: "",
  projectId: null,
};

export function agentAccessConfigPath(home: string = defaultKilnHome()): string {
  return join(home, "agent-access.json");
}

export function readAgentAccessConfig(home: string = defaultKilnHome()): {
  config: AgentAccessConfig;
  error: string | null;
} {
  let raw: string;
  try {
    raw = readFileSync(agentAccessConfigPath(home), "utf8");
  } catch {
    // Missing file is the normal first-run state, not an error.
    return { config: structuredClone(DISABLED), error: null };
  }
  try {
    return { config: AgentAccessConfigSchema.parse(JSON.parse(raw)), error: null };
  } catch (err) {
    return {
      config: structuredClone(DISABLED),
      error: `agent-access.json is invalid and was ignored: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// Write-temp + rename so a concurrent reader never observes a torn file. The
// file holds the plaintext bearer token, so it is created 0600 (owner-only) —
// the same posture as an SSH key, for a locally-minted localhost credential.
export function writeAgentAccessConfig(
  config: AgentAccessConfig,
  home: string = defaultKilnHome(),
): void {
  mkdirSync(home, { recursive: true });
  const path = agentAccessConfigPath(home);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

export interface AgentAccessStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  endpoint: string;
  token: string;
  project: { id: string; name: string } | null;
  error: string | null;
}

export interface AgentAccessOptions {
  home?: string;
  openStore?: (dbPath: string) => Store;
}

export interface AgentAccess {
  status(): AgentAccessStatus;
  /** Start the listener iff the persisted config says enabled — boot wiring. */
  boot(): Promise<void>;
  enable(): Promise<AgentAccessStatus>;
  disable(): Promise<AgentAccessStatus>;
  /** Persist a new port; a running listener rebinds to it immediately. */
  setPort(port: number): Promise<AgentAccessStatus>;
  regenerateToken(): Promise<AgentAccessStatus>;
  pin(projectId: string): Promise<AgentAccessStatus>;
  /**
   * The registry lost this project (projects manager `remove`). If it was the
   * pin, agent access disables loudly — the next status carries the reason.
   */
  projectRemoved(projectId: string, name: string): Promise<void>;
  /** Stop the listener and close the store without changing persisted config. */
  close(): Promise<void>;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(port, HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

// close() alone waits for keep-alive connections to drain, so a connected
// agent could stall a stop or restart indefinitely — and a token regenerate
// must gate the very next request. Destroying connections makes teardown
// immediate and deterministic.
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

// The lifecycle manager. Construction only reads config — it never starts the
// listener; boot wiring (server.ts, next work order) decides whether to call
// enable() based on the persisted flag.
export function createAgentAccess(opts: AgentAccessOptions = {}): AgentAccess {
  const home = opts.home ?? defaultKilnHome();
  const openStore = opts.openStore ?? ((dbPath: string) => new SqliteStore(dbPath));

  const initial = readAgentAccessConfig(home);
  let config = initial.config;
  let lastError: string | null = initial.error;

  let httpServer: Server | null = null;
  let servedStore: Store | null = null;

  const persist = (patch: Partial<AgentAccessConfig>): void => {
    config = { ...config, ...patch };
    writeAgentAccessConfig(config, home);
  };

  const pinnedProject = (): { id: string; name: string; dbPath: string } | null => {
    if (config.projectId === null) return null;
    const entry = readRegistry(home).projects.find((p) => p.id === config.projectId);
    return entry ? { id: entry.id, name: entry.name, dbPath: entry.dbPath } : null;
  };

  const stop = async (): Promise<void> => {
    if (httpServer) {
      await closeServer(httpServer);
      httpServer = null;
    }
    if (servedStore) {
      servedStore.close();
      servedStore = null;
    }
  };

  // (Re)start the listener from the current config. Any prior listener and
  // store are torn down first, so regenerate/pin restarts are one code path.
  const start = async (): Promise<void> => {
    await stop();

    const project = pinnedProject();
    if (!project) {
      lastError =
        config.projectId === null
          ? "no project pinned: pin a project before enabling agent access"
          : `pinned project ${config.projectId} is not in the registry: pin another project`;
      return;
    }

    const store = openStore(project.dbPath);
    const server = createKilnHttpServer({ store, token: config.token, endpoint: ENDPOINT });
    try {
      await listen(server, config.port);
    } catch (err) {
      store.close();
      const code = (err as NodeJS.ErrnoException).code;
      lastError =
        code === "EADDRINUSE"
          ? `port ${config.port} is already in use: free it or change the agent access port`
          : `failed to bind port ${config.port}: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    httpServer = server;
    servedStore = store;
    lastError = null;
  };

  return {
    async boot(): Promise<void> {
      if (config.enabled) await start();
    },

    status(): AgentAccessStatus {
      const project = pinnedProject();
      return {
        enabled: config.enabled,
        running: httpServer !== null,
        port: config.port,
        endpoint: `http://${HOST}:${config.port}${ENDPOINT}`,
        token: config.token,
        project: project ? { id: project.id, name: project.name } : null,
        error: lastError,
      };
    },

    async enable(): Promise<AgentAccessStatus> {
      // A missing pin falls back to the registry default once, explicitly
      // persisted — status never leaves the served project implicit.
      if (config.projectId === null) {
        const fallback = readRegistry(home).defaultProject;
        if (fallback !== null) persist({ projectId: fallback });
      }
      if (!config.token) persist({ token: generateToken() });
      persist({ enabled: true });
      await start();
      return this.status();
    },

    async disable(): Promise<AgentAccessStatus> {
      persist({ enabled: false });
      await stop();
      lastError = null;
      return this.status();
    },

    async setPort(port: number): Promise<AgentAccessStatus> {
      persist({ port });
      // A running listener follows the port immediately; when down, the
      // persisted port applies on the next enable.
      if (httpServer) await start();
      return this.status();
    },

    async regenerateToken(): Promise<AgentAccessStatus> {
      persist({ token: generateToken() });
      // Restart so the new token gates the very next request; when the
      // listener is down (disabled or bind-failed), there is nothing to
      // restart and the persisted token applies on the next enable.
      if (httpServer) await start();
      return this.status();
    },

    async pin(projectId: string): Promise<AgentAccessStatus> {
      const entry = readRegistry(home).projects.find((p) => p.id === projectId);
      if (!entry) throw new NotFoundError(`project ${projectId}`);
      persist({ projectId });
      if (httpServer) await start();
      return this.status();
    },

    async projectRemoved(projectId: string, name: string): Promise<void> {
      if (config.projectId !== projectId) return;
      // Disable loudly (blueprint convention): the pin is cleared so a later
      // enable falls back to the registry default instead of a ghost id, and
      // the reason names the removed project until the next lifecycle action.
      persist({ enabled: false, projectId: null });
      await stop();
      lastError = `pinned project "${name}" was removed from the registry — agent access was disabled; pin another project to re-enable`;
    },

    close: stop,
  };
}
