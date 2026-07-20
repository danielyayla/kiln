import { defineConfig } from "vitest/config";

// node:sqlite needs the --experimental-sqlite flag on Node 22.x. Node 24+ omits it.
export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: { forks: { execArgv: ["--experimental-sqlite"] } },
  },
});
