import { resolve } from "node:path";
import { defineConfig } from "tsup";

// The @kiln/mcp-server dist entry is also the `kiln-mcp` CLI: its
// run-when-main guard compares import.meta.url to argv[1], which becomes TRUE
// once the code is inlined into this bundle's main.js — the sidecar would
// demand KILN_MCP_TOKEN at boot. Alias the package to its pure library module
// instead; the import sites keep the public package name.
const mcpServerLibAlias = {
  "@kiln/mcp-server": resolve(__dirname, "../../packages/mcp-server/src/server.ts"),
};

// Bundles the sidecar to a single JS file (dist-sidecar/main.js). This is the
// unit a future packaging step compiles to a true single-file binary
// (Node SEA / bun compile); for dev and WO-13 it runs under node directly.
export default defineConfig({
  entry: { main: "sidecar/main.ts" },
  outDir: "dist-sidecar",
  format: ["esm"],
  noExternal: [/.*/],
  clean: true,
  sourcemap: true,
  esbuildOptions(options) {
    options.alias = { ...options.alias, ...mcpServerLibAlias };
  },
});
