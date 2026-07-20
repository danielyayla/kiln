import { defineConfig } from "vitest/config";

// node:sqlite needs --experimental-sqlite on Node 22.x (stable on 24+).
export default defineConfig({
  test: {
    include: ["sidecar/**/*.test.ts", "src/**/*.test.ts"],
    pool: "forks",
    poolOptions: { forks: { execArgv: ["--experimental-sqlite"] } },
  },
});
