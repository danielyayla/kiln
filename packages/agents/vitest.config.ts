import { defineConfig } from "vitest/config";

// The --experimental-sqlite flag mirrors the other packages: @kiln/core loads
// node:sqlite at import time, and future tests here will exercise the store.
export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: { forks: { execArgv: ["--experimental-sqlite"] } },
  },
});
