import { defineConfig } from "tsup";

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
});
