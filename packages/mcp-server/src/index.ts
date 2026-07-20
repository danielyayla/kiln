import { resolveDbPath, SqliteStore } from "@kiln/core";
import { createKilnHttpServer } from "./server.js";

export { buildMcpServer, createKilnHttpServer, type KilnServerConfig } from "./server.js";
export { registerTools } from "./tools.js";
export { isAuthorized, extractBearerToken } from "./auth.js";
// The status lifecycle now lives in @kiln/core (shared with the workspace board);
// import allowedNextStatuses / canTransition from there.

interface Env {
  dbPath: string;
  token: string;
  port: number;
  host: string;
  endpoint: string;
}

// Startup-time project resolution (Projects feature): the served store is
// fixed for the life of the process — deliberately NOT synchronized with the
// desktop app's active project, so switching in the app never yanks an agent
// mid-work-order onto another project. `--project <id|slug|name>` becomes
// KILN_PROJECT for this process only; core's order applies (KILN_DB_PATH >
// KILN_PROJECT/--project > registry default > legacy path).
export function resolveServerDbPath(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
  home?: string,
): string {
  const i = argv.indexOf("--project");
  const ref = i === -1 ? undefined : argv[i + 1];
  if (i !== -1 && ref === undefined) throw new Error("--project requires a value");
  const merged = ref === undefined ? env : { ...env, KILN_PROJECT: ref };
  return home === undefined ? resolveDbPath(merged) : resolveDbPath(merged, home);
}

function readEnv(): Env {
  const token = process.env.KILN_MCP_TOKEN ?? "";
  if (!token) {
    throw new Error(
      "KILN_MCP_TOKEN is required: set it to the bearer token clients must present.",
    );
  }
  return {
    dbPath: resolveServerDbPath(),
    token,
    port: Number(process.env.KILN_MCP_PORT ?? process.env.PORT ?? 3001),
    host: process.env.KILN_MCP_HOST ?? "127.0.0.1",
    endpoint: process.env.KILN_MCP_ENDPOINT ?? "/mcp",
  };
}

// CLI entry: open the shared store and serve the MCP bridge until killed.
function main(): void {
  const env = readEnv();
  const store = new SqliteStore(env.dbPath);
  const httpServer = createKilnHttpServer({ store, token: env.token, endpoint: env.endpoint });

  const shutdown = () => {
    httpServer.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  httpServer.listen(env.port, env.host, () => {
    console.error(
      `kiln-mcp-server listening on http://${env.host}:${env.port}${env.endpoint} (db: ${env.dbPath})`,
    );
  });
}

// Only run when executed directly, not when imported (e.g. by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
