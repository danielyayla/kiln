import { defineConfig } from "vitest/config";

// The store opens node:sqlite, which needs the --experimental-sqlite flag on
// Node 22.x (Node 24+ omits it). Mirrors packages/core's test config.
export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: { forks: { execArgv: ["--experimental-sqlite"] } },
  },
});
