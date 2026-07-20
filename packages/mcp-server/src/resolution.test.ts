import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProject } from "@kiln/core";
import { resolveServerDbPath } from "./index.js";

const home = join(tmpdir(), `kiln-mcp-resolution-test-${process.pid}`);
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("resolveServerDbPath", () => {
  it("follows the registry default with no overrides, legacy path with no registry", () => {
    expect(resolveServerDbPath({}, [], home)).toBe(join(home, "kiln.db"));
    const alpha = createProject("Alpha", { home });
    expect(resolveServerDbPath({}, [], home)).toBe(alpha.dbPath);
  });

  it("--project beats the default and an inherited KILN_PROJECT; unknown throws", () => {
    createProject("Alpha", { home });
    const beta = createProject("Beta", { home });
    expect(resolveServerDbPath({}, ["--project", "beta"], home)).toBe(beta.dbPath);
    expect(resolveServerDbPath({ KILN_PROJECT: "alpha" }, ["--project", "Beta"], home)).toBe(
      beta.dbPath,
    );
    expect(() => resolveServerDbPath({}, ["--project", "ghost"], home)).toThrow(/Unknown project/);
    expect(() => resolveServerDbPath({}, ["--project"], home)).toThrow(/requires a value/);
  });

  it("KILN_PROJECT resolves from the registry; KILN_DB_PATH beats everything", () => {
    const alpha = createProject("Alpha", { home });
    createProject("Beta", { home });
    expect(resolveServerDbPath({ KILN_PROJECT: "alpha" }, [], home)).toBe(alpha.dbPath);
    const pinned = join(home, "pinned.db");
    expect(resolveServerDbPath({ KILN_DB_PATH: pinned }, ["--project", "alpha"], home)).toBe(
      pinned,
    );
  });
});
