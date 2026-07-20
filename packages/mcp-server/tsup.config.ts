import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/seed.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  // Both entries are executable CLIs. The node:sqlite runtime dependency still
  // needs --experimental-sqlite on Node 22.x, so prefer the `start`/`seed`
  // package scripts (which pass the flag) over invoking these directly.
  banner: { js: "#!/usr/bin/env node" },
});
