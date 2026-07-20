import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDbPath } from "./db-path";

const scratch = join(tmpdir(), `kiln-db-path-test-${process.pid}`);
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("resolveDbPath", () => {
  it("returns KILN_DB_PATH when set and creates its parent directory", () => {
    const path = join(scratch, "nested", "kiln.db");
    expect(resolveDbPath({ KILN_DB_PATH: path })).toBe(path);
    expect(existsSync(join(scratch, "nested"))).toBe(true);
  });

  it("defaults to <home>/kiln.db when KILN_DB_PATH is unset and no registry exists", () => {
    expect(resolveDbPath({}, scratch)).toBe(join(scratch, "kiln.db"));
  });

  it("passes :memory: through without touching the filesystem", () => {
    expect(resolveDbPath({ KILN_DB_PATH: ":memory:" })).toBe(":memory:");
  });
});
