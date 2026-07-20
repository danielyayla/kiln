import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readRegistry, SqliteStore } from "@kiln/core";
import { buildApi } from "./api.js";
import { createProjectManager, type ProjectManager } from "./projects.js";

const home = join(tmpdir(), `kiln-sidecar-projects-test-${process.pid}`);

let manager: ProjectManager;
let app: ReturnType<typeof buildApi>;

// Boot against a scratch home with no env pin: resolution falls to the legacy
// <home>/kiln.db, opening creates it, and adoption registers it ("My project"
// — a fresh store has no product root).
function boot(env: NodeJS.ProcessEnv = {}): void {
  manager = createProjectManager({ env, home });
  app = buildApi(manager.store, { projects: manager });
}

beforeEach(() => {
  mkdirSync(home, { recursive: true });
  boot();
});
afterEach(() => {
  manager.close();
  rmSync(home, { recursive: true, force: true });
});

async function json<T>(res: Response, status = 200): Promise<T> {
  expect(res.status).toBe(status);
  return (await res.json()) as T;
}

interface ListShape {
  projects: { id: string; name: string; slug: string }[];
  defaultProject: string | null;
  activeProject: string | null;
}

const list = async (): Promise<ListShape> => json<ListShape>(await app.request("/projects"));

const createProjectReq = async (name: string) =>
  json<{ id: string; name: string; slug: string }>(
    await app.request("/projects", {
      method: "POST",
      body: JSON.stringify({ name }),
      headers: { "content-type": "application/json" },
    }),
    201,
  );

describe("project manager boot", () => {
  it("adopts the fresh legacy store as the first (active, default) project", async () => {
    const state = await list();
    expect(state.projects).toHaveLength(1);
    expect(state.projects[0].name).toBe("My project");
    expect(state.activeProject).toBe(state.projects[0].id);
    expect(state.defaultProject).toBe(state.projects[0].id);
    expect(manager.activeDbPath()).toBe(join(home, "kiln.db"));
  });

  it("never exposes dbPath over the API", async () => {
    const state = await list();
    expect(Object.keys(state.projects[0])).not.toContain("dbPath");
  });

  it("skips adoption entirely when KILN_DB_PATH pins the store", async () => {
    manager.close();
    rmSync(join(home, "projects.json"), { force: true });
    const pinned = join(home, "pinned", "scratch.db");
    boot({ KILN_DB_PATH: pinned });
    expect(manager.activeDbPath()).toBe(pinned);
    const state = await list();
    expect(state.projects).toEqual([]);
    expect(state.activeProject).toBeNull();
    expect(existsSync(join(home, "projects.json"))).toBe(false);
  });
});

describe("project routes", () => {
  it("creates a project with a seeded product root named after it", async () => {
    const created = await createProjectReq("Acme App");
    expect(created.slug).toBe("acme-app");

    const seededPath = join(home, "projects", "acme-app", "kiln.db");
    const seeded = new SqliteStore(seededPath);
    const requirements = seeded.listEntities("requirement");
    // The design-doc blueprint is seeded too, linked `details` to the root.
    const blueprints = seeded.listEntities("blueprint");
    const detailsOf = blueprints[0] && seeded.linked(blueprints[0].id, "details");
    seeded.close();
    expect(requirements.map((r) => r.title)).toEqual(["Acme App"]);
    expect(blueprints.map((b) => b.title)).toEqual(["Acme App system architecture"]);
    expect(detailsOf?.map((r) => r.title)).toEqual(["Acme App"]);

    // Creation does NOT activate — the adopted project is still active.
    const state = await list();
    expect(state.projects).toHaveLength(2);
    expect(state.activeProject).not.toBe(created.id);
  });

  it("rejects a blank name", async () => {
    const res = await app.request("/projects", {
      method: "POST",
      body: JSON.stringify({ name: "   " }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("renames a project in the registry only", async () => {
    const created = await createProjectReq("Acme App");
    const renamed = await json<{ name: string; slug: string }>(
      await app.request(`/projects/${created.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "Acme Platform" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(renamed.name).toBe("Acme Platform");
    expect(renamed.slug).toBe("acme-app");
    expect((await list()).projects.map((p) => p.name)).toContain("Acme Platform");
  });

  it("404s activate/rename/remove for unknown project ids", async () => {
    expect((await app.request("/projects/ghost/activate", { method: "POST" })).status).toBe(404);
    expect((await app.request("/projects/ghost", { method: "DELETE" })).status).toBe(404);
  });
});

describe("activation swap", () => {
  it("post-activate requests hit the new store; the old store is closed", async () => {
    // Mark the adopted store so we can tell the two apart through the API.
    await app.request("/entities", {
      method: "POST",
      body: JSON.stringify({ type: "requirement", title: "Legacy marker" }),
      headers: { "content-type": "application/json" },
    });

    const created = await createProjectReq("Acme App");
    const state = await json<ListShape>(
      await app.request(`/projects/${created.id}/activate`, { method: "POST" }),
    );
    expect(state.activeProject).toBe(created.id);
    // Activation promotes the project to default (relaunch reopens it).
    expect(state.defaultProject).toBe(created.id);

    // The same /entities route now serves the NEW store: only the seeded root.
    const titles = (
      await json<{ title: string }[]>(await app.request("/entities?type=requirement"))
    ).map((e) => e.title);
    expect(titles).toEqual(["Acme App"]);
    expect(titles).not.toContain("Legacy marker");
    expect(manager.activeDbPath()).toBe(join(home, "projects", "acme-app", "kiln.db"));
  });

  it("closes the previous store on swap and re-activating is a no-op", async () => {
    const opened: SqliteStore[] = [];
    manager.close();
    manager = createProjectManager({
      env: {},
      home,
      openStore: (dbPath) => {
        const store = new SqliteStore(dbPath);
        opened.push(store);
        return store;
      },
    });
    app = buildApi(manager.store, { projects: manager });

    const created = await createProjectReq("Acme App");
    const first = opened[0];
    await app.request(`/projects/${created.id}/activate`, { method: "POST" });
    // The boot store is closed: further use throws.
    expect(() => first.listEntities("requirement")).toThrow();

    const countAfterSwap = opened.length;
    await app.request(`/projects/${created.id}/activate`, { method: "POST" });
    expect(opened.length).toBe(countAfterSwap);
  });

  it("a failed activation leaves the current store fully active", async () => {
    const created = await createProjectReq("Acme App");
    // Corrupt the registry entry's path via a raw write to force an open error.
    const registry = readRegistry(home);
    const target = registry.projects.find((p) => p.id === created.id)!;
    target.dbPath = join(home, "not-a-dir-file");
    writeFileSync(join(home, "not-a-dir-file"), "not a database", "utf8");
    writeFileSync(join(home, "projects.json"), JSON.stringify(registry), "utf8");

    const res = await app.request(`/projects/${created.id}/activate`, { method: "POST" });
    expect(res.status).toBe(500);
    // The previously active store still serves requests.
    expect((await app.request("/entities?type=requirement")).status).toBe(200);
    expect((await list()).activeProject).not.toBe(created.id);
  });
});

describe("remove", () => {
  it("removes a registry entry only; the store file survives", async () => {
    const created = await createProjectReq("Acme App");
    const dbPath = join(home, "projects", "acme-app", "kiln.db");
    expect(existsSync(dbPath)).toBe(true);

    await json<{ ok: boolean }>(await app.request(`/projects/${created.id}`, { method: "DELETE" }));
    expect((await list()).projects.map((p) => p.name)).toEqual(["My project"]);
    expect(existsSync(dbPath)).toBe(true);
  });

  it("refuses to remove the active project", async () => {
    const active = (await list()).activeProject!;
    const res = await app.request(`/projects/${active}`, { method: "DELETE" });
    expect(res.status).toBe(400);
    expect((await list()).projects).toHaveLength(1);
  });

  it("reassigns the default when the default project is removed", async () => {
    const created = await createProjectReq("Acme App");
    await app.request(`/projects/${created.id}/activate`, { method: "POST" });
    // created is now default AND active; switch back so it is default-only.
    const adopted = (await list()).projects.find((p) => p.name === "My project")!;
    await app.request(`/projects/${adopted.id}/activate`, { method: "POST" });
    // Activation promotes adopted to default; hand default back to created via
    // a raw registry edit to simulate a stale default.
    const registry = readRegistry(home);
    registry.defaultProject = created.id;
    writeFileSync(join(home, "projects.json"), JSON.stringify(registry), "utf8");

    await app.request(`/projects/${created.id}`, { method: "DELETE" });
    expect((await list()).defaultProject).toBe(adopted.id);
  });
});
