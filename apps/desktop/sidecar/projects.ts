import {
  adoptLegacyStore,
  ConstraintError,
  createProject,
  defaultKilnHome,
  NotFoundError,
  readRegistry,
  resolveProjectDbPath,
  seedProject,
  SqliteStore,
  touchProject,
  writeRegistry,
  type ProjectEntry,
  type Store,
} from "@kiln/core";

// The sidecar's project manager (Projects feature): owns the ACTIVE store and
// the registry routes' logic. Every existing API route keeps operating on the
// `store` closure it always had — `manager.store` is a Proxy that resolves each
// property access against the currently active store, so activation swaps the
// backing store without touching a single route body. Activation is the ONLY
// way the active store changes; no route accepts a per-request override.

// The webview is path-blind: registry entries cross the HTTP boundary without
// their dbPath.
export type PublicProject = Omit<ProjectEntry, "dbPath">;

const publicProject = ({ dbPath: _, ...rest }: ProjectEntry): PublicProject => rest;

export interface ProjectList {
  projects: PublicProject[];
  defaultProject: string | null;
  activeProject: string | null;
}

export interface ProjectManagerOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  openStore?: (dbPath: string) => Store;
}

export interface ProjectManager {
  /** Proxy over the active store — hand this to buildApi. */
  store: Store;
  activeDbPath(): string;
  list(): ProjectList;
  create(name: string): PublicProject;
  activate(id: string): ProjectList;
  rename(id: string, name: string): PublicProject;
  remove(id: string): void;
  close(): void;
}

export function createProjectManager(opts: ProjectManagerOptions = {}): ProjectManager {
  const env = opts.env ?? process.env;
  const home = opts.home ?? defaultKilnHome();
  const openStore = opts.openStore ?? ((dbPath: string) => new SqliteStore(dbPath));

  // Boot: resolve first (KILN_DB_PATH > KILN_PROJECT > registry default >
  // legacy), open, then adopt. Opening the legacy path creates the file, so on
  // a fresh install adoption registers it too ("My project"). An explicit
  // KILN_DB_PATH pin skips adoption entirely — dev/test runs pointed at a
  // scratch db must never write the user's real registry.
  let activePath = resolveProjectDbPath(env, home);
  let active = openStore(activePath);
  if (!env.KILN_DB_PATH) adoptLegacyStore({ home });
  let activeId =
    readRegistry(home).projects.find((p) => p.dbPath === activePath)?.id ?? null;

  const mustFind = (id: string): ProjectEntry => {
    const entry = readRegistry(home).projects.find((p) => p.id === id);
    if (!entry) throw new NotFoundError(`project ${id}`);
    return entry;
  };

  const list = (): ProjectList => {
    const registry = readRegistry(home);
    return {
      projects: registry.projects.map(publicProject),
      defaultProject: registry.defaultProject,
      activeProject: activeId,
    };
  };

  return {
    // Each access resolves against the CURRENT active store, so route closures
    // built once at boot follow every activation automatically.
    store: new Proxy({} as Store, {
      get(_, prop) {
        const value = active[prop as keyof Store];
        return typeof value === "function" ? value.bind(active) : value;
      },
    }),

    activeDbPath: () => activePath,
    list,

    create(name: string): PublicProject {
      const entry = createProject(name, { home });
      // Seed the product root AND its design-doc blueprint so the Phase-14/15
      // root conventions — and the global design doc that lineage folds into
      // every work order's context — hold from the first minute.
      const seed = openStore(entry.dbPath);
      try {
        seedProject(seed, name);
      } finally {
        seed.close();
      }
      return publicProject(entry);
    },

    activate(id: string): ProjectList {
      const entry = mustFind(id);
      if (entry.id !== activeId) {
        // Open the new store BEFORE touching the old one, then swap and close
        // — all synchronous, so no request can interleave with a half-swapped
        // state (an open failure leaves the old store fully active).
        const next = openStore(entry.dbPath);
        const previous = active;
        active = next;
        activePath = entry.dbPath;
        activeId = entry.id;
        previous.close();
      }
      // Stamps lastOpenedAt and promotes to default — the next launch reopens
      // the last active project.
      touchProject(id, { home });
      return list();
    },

    rename(id: string, name: string): PublicProject {
      const entry = mustFind(id);
      const registry = readRegistry(home);
      const target = registry.projects.find((p) => p.id === entry.id)!;
      target.name = name;
      writeRegistry(registry, home);
      return publicProject(target);
    },

    // Registry-only remove: the store file always survives on disk (v1 has no
    // hard delete). The active project cannot be removed — activate another
    // one first; that keeps activeId always resolvable while a registry
    // exists.
    remove(id: string): void {
      const entry = mustFind(id);
      if (entry.id === activeId)
        throw new ConstraintError("cannot remove the active project; activate another project first");
      const registry = readRegistry(home);
      registry.projects = registry.projects.filter((p) => p.id !== entry.id);
      if (registry.defaultProject === entry.id)
        registry.defaultProject = activeId ?? registry.projects[0]?.id ?? null;
      writeRegistry(registry, home);
    },

    close: () => active.close(),
  };
}
