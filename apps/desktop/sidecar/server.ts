import { serve } from "@hono/node-server";
import { buildApi } from "./api.js";
import { createAgentAccess } from "./agent-access.js";
import { createProjectManager } from "./projects.js";

// Opens the active project's store (Projects feature: registry-aware
// resolution + legacy adoption live in the manager), binds the API to
// localhost, and prints a machine-readable readiness line the launcher (dev
// script or Tauri) waits on. Shared by the dev entry (main.ts) and the
// packaged binary (binary.ts).
export function start(): void {
  const port = Number(process.env.KILN_SIDECAR_PORT ?? 4823);

  const projects = createProjectManager();
  const agentAccess = createAgentAccess();
  const app = buildApi(projects.store, { projects, agentAccess });

  // Agent access follows the persisted toggle: enabled in the last session →
  // the MCP listener serves again without any API call. boot() never throws —
  // bind/pin failures land in status(), where Settings renders them.
  void agentAccess.boot();

  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
    console.log(`KILN_SIDECAR_READY ${info.port}`);
    console.error(
      `kiln sidecar listening on http://127.0.0.1:${info.port} (db: ${projects.activeDbPath()})`,
    );
  });

  const shutdown = () => {
    server.close();
    // close() stops the agent listener and closes its dedicated store.
    void agentAccess.close().finally(() => {
      projects.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
