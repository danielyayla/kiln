import { resolve } from "node:path";
import { defineConfig } from "tsup";

// Same alias as tsup.config.ts: skip the @kiln/mcp-server CLI entry (its
// run-when-main guard misfires inside a bundle) and inline the pure library.
const mcpServerLibAlias = {
  "@kiln/mcp-server": resolve(__dirname, "../../packages/mcp-server/src/server.ts"),
};

// Bundles the sidecar binary entry to a single CommonJS file for Node SEA.
// SEA evaluates its main script as CommonJS, so this target is CJS (the dev
// sidecar bundle in tsup.config.ts stays ESM).
export default defineConfig({
  entry: { binary: "sidecar/binary.ts" },
  outDir: "dist-binary",
  format: ["cjs"],
  platform: "node",
  target: "node22",
  noExternal: [/.*/],
  clean: true,
  sourcemap: false,
  esbuildOptions(options) {
    options.alias = { ...options.alias, ...mcpServerLibAlias };
  },
});
