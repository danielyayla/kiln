import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  // Executable CLI. node:sqlite still needs --experimental-sqlite on Node 22.x,
  // so prefer `pnpm -C packages/cli kiln -- <cmd>` (which passes the flag).
  banner: { js: "#!/usr/bin/env node" },
});
