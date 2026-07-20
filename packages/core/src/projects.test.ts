import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDbPath } from "./db/db-path";
import {
  adoptLegacyStore,
  createProject,
  projectDbPath,
  readRegistry,
  registryPath,
  resolveProjectDbPath,
  slugify,
  touchProject,
  writeRegistry,
} from "./projects";
import { SqliteStore } from "./store";

const home = join(tmpdir(), `kiln-projects-test-${process.pid}`);
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// Builds a legacy store at <home>/kiln.db. With a root title, the store gets a
// product root (unique parentless requirement WITH a requirement child — the
// roots.ts convention); without one, a lone flat requirement (no product root).
function seedLegacyStore(rootTitle?: string): void {
  mkdirSync(home, { recursive: true });
  const store = new SqliteStore(join(home, "kiln.db"));
  if (rootTitle) {
    const root = store.createEntity({ type: "requirement", title: rootTitle, body: "" });
    const child = store.createEntity({ type: "requirement", title: "Some feature", body: "" });
    store.link(child.id, root.id, "child_of");
  } else {
    store.createEntity({ type: "requirement", title: "Flat requirement", body: "" });
  }
  store.close();
}

describe("readRegistry / writeRegistry", () => {
  it("reads a missing registry as empty without throwing", () => {
    expect(readRegistry(home)).toEqual({ projects: [], defaultProject: null });
  });

  it("reads a malformed registry (invalid JSON) as empty", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(registryPath(home), "{ not json", "utf8");
    expect(readRegistry(home)).toEqual({ projects: [], defaultProject: null });
  });

  it("reads a registry with the wrong shape as empty", () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(registryPath(home), JSON.stringify({ projects: [{ id: 1 }] }), "utf8");
    expect(readRegistry(home)).toEqual({ projects: [], defaultProject: null });
  });

  it("round-trips a registry and leaves no temp file behind", () => {
    const entry = createProject("Alpha", { home });
    expect(readRegistry(home).projects).toEqual([entry]);
    expect(existsSync(`${registryPath(home)}.tmp`)).toBe(false);
  });
});

describe("slugify / projectDbPath", () => {
  it("produces filesystem-safe slugs", () => {
    expect(slugify("My Cool App!")).toBe("my-cool-app");
    expect(slugify("  Émile's projet  ")).toBe("emile-s-projet");
    expect(slugify("///")).toBe("project");
  });

  it("uniquifies against taken slugs with numeric suffixes", () => {
    expect(slugify("Alpha", ["alpha"])).toBe("alpha-2");
    expect(slugify("Alpha", ["alpha", "alpha-2"])).toBe("alpha-3");
  });

  it("resolves the per-project db path under <home>/projects/<slug>/kiln.db", () => {
    expect(projectDbPath("alpha", home)).toBe(join(home, "projects", "alpha", "kiln.db"));
  });
});

describe("createProject", () => {
  it("registers the first project as the default and creates its directory", () => {
    const entry = createProject("Alpha", { home });
    expect(entry.dbPath).toBe(join(home, "projects", "alpha", "kiln.db"));
    expect(existsSync(join(home, "projects", "alpha"))).toBe(true);
    expect(readRegistry(home).defaultProject).toBe(entry.id);
  });

  it("gives duplicate names distinct slugs and db paths, keeping the first default", () => {
    const first = createProject("Alpha", { home });
    const second = createProject("Alpha", { home });
    expect(second.slug).toBe("alpha-2");
    expect(second.dbPath).not.toBe(first.dbPath);
    const registry = readRegistry(home);
    expect(registry.projects).toHaveLength(2);
    expect(registry.defaultProject).toBe(first.id);
  });
});

describe("touchProject", () => {
  it("stamps lastOpenedAt and promotes the project to default", () => {
    const first = createProject("Alpha", { home });
    const second = createProject("Beta", { home });
    const now = new Date("2026-07-20T12:00:00Z");
    touchProject(second.id, { home, now });
    const registry = readRegistry(home);
    expect(registry.defaultProject).toBe(second.id);
    expect(registry.projects.find((p) => p.id === second.id)?.lastOpenedAt).toBe(
      now.toISOString(),
    );
    expect(registry.projects.find((p) => p.id === first.id)?.lastOpenedAt).toBeNull();
  });

  it("ignores unknown ids", () => {
    createProject("Alpha", { home });
    const before = readRegistry(home);
    touchProject("nope", { home });
    expect(readRegistry(home)).toEqual(before);
  });
});

describe("adoptLegacyStore", () => {
  it("registers the legacy store in place, named from the product root title", () => {
    seedLegacyStore("Kiln");
    const entry = adoptLegacyStore({ home });
    expect(entry?.name).toBe("Kiln");
    expect(entry?.dbPath).toBe(join(home, "kiln.db"));
    expect(readRegistry(home).defaultProject).toBe(entry?.id);
    // Adopted IN PLACE: the file never moves.
    expect(existsSync(join(home, "kiln.db"))).toBe(true);
    expect(existsSync(join(home, "projects"))).toBe(false);
  });

  it("falls back to 'My project' when the store has no product root", () => {
    seedLegacyStore();
    expect(adoptLegacyStore({ home })?.name).toBe("My project");
  });

  it("returns null without a legacy store file", () => {
    expect(adoptLegacyStore({ home })).toBeNull();
    expect(existsSync(registryPath(home))).toBe(false);
  });

  it("is idempotent: a non-empty registry adopts nothing", () => {
    seedLegacyStore("Kiln");
    const first = adoptLegacyStore({ home });
    expect(adoptLegacyStore({ home })).toBeNull();
    expect(readRegistry(home).projects).toEqual([first]);
  });
});

describe("resolveProjectDbPath", () => {
  it("KILN_DB_PATH beats everything and keeps :memory: passthrough", () => {
    createProject("Alpha", { home });
    const explicit = join(home, "elsewhere", "other.db");
    expect(resolveProjectDbPath({ KILN_DB_PATH: explicit, KILN_PROJECT: "alpha" }, home)).toBe(
      explicit,
    );
    expect(existsSync(join(home, "elsewhere"))).toBe(true);
    expect(resolveProjectDbPath({ KILN_DB_PATH: ":memory:" }, home)).toBe(":memory:");
  });

  it("KILN_PROJECT resolves by id, slug, or exact name and beats the default", () => {
    const alpha = createProject("Alpha", { home });
    const beta = createProject("Beta", { home });
    expect(readRegistry(home).defaultProject).toBe(alpha.id);
    expect(resolveProjectDbPath({ KILN_PROJECT: beta.id }, home)).toBe(beta.dbPath);
    expect(resolveProjectDbPath({ KILN_PROJECT: "beta" }, home)).toBe(beta.dbPath);
    expect(resolveProjectDbPath({ KILN_PROJECT: "Beta" }, home)).toBe(beta.dbPath);
  });

  it("throws on an unknown KILN_PROJECT instead of opening the wrong store", () => {
    createProject("Alpha", { home });
    expect(() => resolveProjectDbPath({ KILN_PROJECT: "ghost" }, home)).toThrow(/Unknown project/);
  });

  it("falls back to the registry default, then to the legacy path", () => {
    expect(resolveProjectDbPath({}, home)).toBe(join(home, "kiln.db"));
    const alpha = createProject("Alpha", { home });
    expect(resolveProjectDbPath({}, home)).toBe(alpha.dbPath);
  });

  it("ignores a dangling defaultProject and falls back to the legacy path", () => {
    writeRegistry({ projects: [], defaultProject: "gone" }, home);
    expect(resolveProjectDbPath({}, home)).toBe(join(home, "kiln.db"));
  });
});

describe("resolveDbPath delegation", () => {
  it("keeps the pre-Projects behavior with no registry present", () => {
    expect(resolveDbPath({}, home)).toBe(join(home, "kiln.db"));
    expect(resolveDbPath({ KILN_DB_PATH: ":memory:" }, home)).toBe(":memory:");
  });

  it("serves the registry default once projects exist", () => {
    const entry = createProject("Alpha", { home });
    expect(resolveDbPath({}, home)).toBe(entry.dbPath);
  });
});
