import { defineConfig } from "vitest/config";

// node:sqlite needs the --experimental-sqlite flag on Node 22.x (stable on 24+).
export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: { forks: { execArgv: ["--experimental-sqlite"] } },
  },
});
