// The project-switch flow (Projects feature), kept pure and injectable so the
// ordering rules are unit-testable: activate must resolve BEFORE the cache is
// cleared (no stale project-A data renders under project B), and per-project
// localStorage is re-keyed in between.

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// Per-project UI state lives under these BASE keys — the components that own
// them (FeatureTree, ArtifactsPanel) are untouched by the Projects feature and
// keep reading the base key. On switch we stash the base values under
// `kiln.<projectId>.<suffix>` and load the target project's stash back into
// the base keys, so state is per-project without any component knowing.
const PER_PROJECT_KEYS = ["kiln.nav.collapsed", "kiln.nav.artifactsOpen"] as const;

const projectKey = (projectId: string, baseKey: string) =>
  baseKey.replace(/^kiln\./, `kiln.${projectId}.`);

export function swapProjectStorage(
  storage: StorageLike,
  fromProjectId: string | null,
  toProjectId: string | null,
): void {
  for (const baseKey of PER_PROJECT_KEYS) {
    const current = storage.getItem(baseKey);
    if (fromProjectId !== null) {
      if (current === null) storage.removeItem(projectKey(fromProjectId, baseKey));
      else storage.setItem(projectKey(fromProjectId, baseKey), current);
    }
    const next = toProjectId === null ? null : storage.getItem(projectKey(toProjectId, baseKey));
    if (next === null) storage.removeItem(baseKey);
    else storage.setItem(baseKey, next);
  }
}

export interface SwitchDeps {
  activeProjectId: string | null;
  activate: (id: string) => Promise<unknown>;
  storage: StorageLike;
  /** queryClient.clear — every cached query belongs to the old store. */
  clearCache: () => void;
  /** Shell reset: back to Pulse, drop selection/peek/quick-open. */
  onSwitched: (id: string) => void;
}

export async function switchToProject(id: string, deps: SwitchDeps): Promise<void> {
  if (id === deps.activeProjectId) return;
  await deps.activate(id);
  swapProjectStorage(deps.storage, deps.activeProjectId, id);
  deps.clearCache();
  deps.onSwitched(id);
}

export async function createAndSwitch(
  name: string,
  deps: SwitchDeps & { create: (name: string) => Promise<{ id: string }> },
): Promise<void> {
  const created = await deps.create(name);
  await switchToProject(created.id, deps);
}
