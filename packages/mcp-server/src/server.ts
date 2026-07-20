import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Store } from "@kiln/core";
import { registerTools } from "./tools.js";
import { isAuthorized } from "./auth.js";

export interface KilnServerConfig {
  store: Store;
  /** Bearer token clients must present. Required; an empty token denies all. */
  token: string;
  /** HTTP path the MCP endpoint is served on. Defaults to "/mcp". */
  endpoint?: string;
}

// Build a fresh MCP server wired to the shared store. Registers the tools and
// declares the tools capability.
export function buildMcpServer(store: Store): McpServer {
  const server = new McpServer(
    { name: "kiln-mcp-server", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, store);
  return server;
}

function writeJsonError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

// Serve the MCP tools over streamable HTTP with bearer auth. Runs statelessly:
// a fresh McpServer + transport per POST, all sharing the one long-lived Store.
// This avoids cross-client session/request-id collisions while keeping a single
// SQLite connection.
export function createKilnHttpServer(config: KilnServerConfig): Server {
  const endpoint = config.endpoint ?? "/mcp";

  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== endpoint) {
      writeJsonError(res, 404, "Not found");
      return;
    }

    // Auth gate first — unauthenticated calls never reach the tools.
    if (!isAuthorized(req, config.token)) {
      writeJsonError(res, 401, "Unauthorized: valid bearer token required", {
        "www-authenticate": 'Bearer realm="kiln"',
      });
      return;
    }

    if (req.method !== "POST") {
      // Stateless mode has no server-initiated streams, so GET/DELETE are unused.
      writeJsonError(res, 405, "Method not allowed", { allow: "POST" });
      return;
    }

    const server = buildMcpServer(config.store);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) writeJsonError(res, 500, "Internal server error");
    }
  });
}
