import { defineConfig } from "tsup";

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
});
