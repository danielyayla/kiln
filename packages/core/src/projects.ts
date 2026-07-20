import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { productRoot } from "./graph/roots";
import { SqliteStore } from "./store";

// The project registry (Projects feature): one SQLite file per project, listed
// in ~/.kiln/projects.json. A project is a directory convention plus this
// registry — never a schema change. The registry file is an untrusted boundary
// (hand-editable), so reads validate with Zod and any failure reads as empty;
// a missing or torn registry must never crash an entry point.

export const ProjectEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().min(1),
  dbPath: z.string().min(1),
  createdAt: z.string(),
  lastOpenedAt: z.string().nullable().default(null),
});
export type ProjectEntry = z.infer<typeof ProjectEntrySchema>;

export const ProjectRegistrySchema = z.object({
  projects: z.array(ProjectEntrySchema),
  defaultProject: z.string().nullable().default(null),
});
export type ProjectRegistry = z.infer<typeof ProjectRegistrySchema>;

const EMPTY: ProjectRegistry = { projects: [], defaultProject: null };

// KILN_HOME relocates the whole ~/.kiln directory (registry + default store
// locations) — primarily a seam for scratch environments and tests.
export function defaultKilnHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.KILN_HOME ?? join(homedir(), ".kiln");
}

export function registryPath(home: string = defaultKilnHome()): string {
  return join(home, "projects.json");
}

export function readRegistry(home: string = defaultKilnHome()): ProjectRegistry {
  try {
    return ProjectRegistrySchema.parse(JSON.parse(readFileSync(registryPath(home), "utf8")));
  } catch {
    return structuredClone(EMPTY);
  }
}

// Write-temp + rename so a concurrent reader never observes a torn file.
export function writeRegistry(registry: ProjectRegistry, home: string = defaultKilnHome()): void {
  mkdirSync(home, { recursive: true });
  const path = registryPath(home);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

export function slugify(name: string, taken: Iterable<string> = []): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function projectDbPath(slug: string, home: string = defaultKilnHome()): string {
  return join(home, "projects", slug, "kiln.db");
}

export interface CreateProjectOptions {
  home?: string;
  now?: Date;
}

// Registers a new project and returns its entry. The store file itself is not
// created here — opening it (SqliteStore) creates the schema on first use —
// but the directory is, so a subsequent open cannot fail on a missing parent.
export function createProject(name: string, opts: CreateProjectOptions = {}): ProjectEntry {
  const home = opts.home ?? defaultKilnHome();
  const registry = readRegistry(home);
  const slug = slugify(
    name,
    registry.projects.map((p) => p.slug),
  );
  const entry: ProjectEntry = {
    id: randomUUID(),
    name,
    slug,
    dbPath: projectDbPath(slug, home),
    createdAt: (opts.now ?? new Date()).toISOString(),
    lastOpenedAt: null,
  };
  mkdirSync(dirname(entry.dbPath), { recursive: true });
  registry.projects.push(entry);
  registry.defaultProject ??= entry.id;
  writeRegistry(registry, home);
  return entry;
}

export function touchProject(id: string, opts: CreateProjectOptions = {}): void {
  const home = opts.home ?? defaultKilnHome();
  const registry = readRegistry(home);
  const entry = registry.projects.find((p) => p.id === id);
  if (!entry) return;
  entry.lastOpenedAt = (opts.now ?? new Date()).toISOString();
  registry.defaultProject = entry.id;
  writeRegistry(registry, home);
}

// Reads the product-root title of an existing store to name an adopted
// project. Any failure (unreadable file, no root convention) reads as null.
export function readProductRootTitle(dbPath: string): string | null {
  try {
    const store = new SqliteStore(dbPath);
    try {
      return productRoot(store)?.title ?? null;
    } finally {
      store.close();
    }
  } catch {
    return null;
  }
}

// First-run upgrade: an existing legacy store at <home>/kiln.db is registered
// IN PLACE as the first project — no file ever moves (a silent second copy is
// the stray-store failure class resolveDbPath was built to kill). Idempotent:
// a non-empty registry or a missing legacy file returns null.
export function adoptLegacyStore(opts: CreateProjectOptions = {}): ProjectEntry | null {
  const home = opts.home ?? defaultKilnHome();
  const registry = readRegistry(home);
  if (registry.projects.length > 0) return null;
  const legacyPath = join(home, "kiln.db");
  if (!existsSync(legacyPath)) return null;
  const name = readProductRootTitle(legacyPath) ?? "My project";
  const entry: ProjectEntry = {
    id: randomUUID(),
    name,
    slug: slugify(name),
    dbPath: legacyPath,
    createdAt: (opts.now ?? new Date()).toISOString(),
    lastOpenedAt: null,
  };
  writeRegistry({ projects: [entry], defaultProject: entry.id }, home);
  return entry;
}

// Full per-process resolution order: KILN_DB_PATH (absolute override, exactly
// the pre-Projects semantics) > KILN_PROJECT (registry lookup by id, slug, or
// exact name — unknown THROWS rather than silently opening the wrong store) >
// the registry's default project > the legacy <home>/kiln.db location. With no
// registry present this returns the same path as before the Projects feature.
export function resolveProjectDbPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = defaultKilnHome(),
): string {
  if (env.KILN_DB_PATH) {
    if (env.KILN_DB_PATH !== ":memory:") mkdirSync(dirname(env.KILN_DB_PATH), { recursive: true });
    return env.KILN_DB_PATH;
  }
  const registry = readRegistry(home);
  if (env.KILN_PROJECT) {
    const wanted = env.KILN_PROJECT;
    const entry = registry.projects.find(
      (p) => p.id === wanted || p.slug === wanted || p.name === wanted,
    );
    if (!entry) throw new Error(`Unknown project: ${wanted} (no match in ${registryPath(home)})`);
    mkdirSync(dirname(entry.dbPath), { recursive: true });
    return entry.dbPath;
  }
  const fallback = registry.projects.find((p) => p.id === registry.defaultProject);
  const path = fallback?.dbPath ?? join(home, "kiln.db");
  mkdirSync(dirname(path), { recursive: true });
  return path;
}
