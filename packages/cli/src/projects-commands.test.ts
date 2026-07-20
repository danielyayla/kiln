import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NotFoundError, resolveDbPath, SqliteStore } from "@kiln/core";
import { cliEnv, runProjectsCreate, runProjectsList, runProjectsUse } from "./commands.js";

const home = join(tmpdir(), `kiln-cli-projects-test-${process.pid}`);
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("kiln projects", () => {
  it("list is empty on a fresh home", () => {
    expect(runProjectsList(home)).toEqual({ projects: [], defaultProject: null });
  });

  it("create registers the project and seeds its product root", () => {
    const entry = runProjectsCreate("Acme App", home);
    expect(entry.slug).toBe("acme-app");
    const { projects, defaultProject } = runProjectsList(home);
    expect(projects.map((p) => p.name)).toEqual(["Acme App"]);
    expect(defaultProject).toBe(entry.id);

    const store = new SqliteStore(entry.dbPath);
    const roots = store.listEntities("requirement");
    const blueprints = store.listEntities("blueprint");
    const detailsOf = blueprints[0] && store.linked(blueprints[0].id, "details");
    store.close();
    expect(roots.map((r) => r.title)).toEqual(["Acme App"]);
    expect(blueprints.map((b) => b.title)).toEqual(["Acme App system architecture"]);
    expect(detailsOf?.map((r) => r.title)).toEqual(["Acme App"]);
  });

  it("use sets the default by id, slug, or name; unknown refs throw", () => {
    const alpha = runProjectsCreate("Alpha", home);
    const beta = runProjectsCreate("Beta", home);
    expect(runProjectsList(home).defaultProject).toBe(alpha.id);

    expect(runProjectsUse("beta", home).id).toBe(beta.id);
    expect(runProjectsList(home).defaultProject).toBe(beta.id);
    expect(runProjectsUse("Alpha", home).id).toBe(alpha.id);
    expect(runProjectsUse(beta.id, home).id).toBe(beta.id);
    expect(() => runProjectsUse("ghost", home)).toThrow(NotFoundError);
  });
});

describe("--project resolution precedence", () => {
  it("KILN_DB_PATH beats --project; --project beats the registry default", () => {
    const alpha = runProjectsCreate("Alpha", home);
    const beta = runProjectsCreate("Beta", home);

    // Registry default (no overrides).
    expect(resolveDbPath(cliEnv({}, undefined), home)).toBe(alpha.dbPath);
    // --project (as KILN_PROJECT) beats the default.
    expect(resolveDbPath(cliEnv({}, "beta"), home)).toBe(beta.dbPath);
    // --project overrides an inherited KILN_PROJECT env for this invocation.
    expect(resolveDbPath(cliEnv({ KILN_PROJECT: "alpha" }, "beta"), home)).toBe(beta.dbPath);
    // KILN_DB_PATH remains the ultimate override.
    const pinned = join(home, "pinned.db");
    expect(resolveDbPath(cliEnv({ KILN_DB_PATH: pinned }, "beta"), home)).toBe(pinned);
    // Unknown --project refuses to open anything.
    expect(() => resolveDbPath(cliEnv({}, "ghost"), home)).toThrow(/Unknown project/);
  });
});
