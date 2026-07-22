import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  applySuggestion,
  ConstraintError,
  createProject,
  ENTITY_TYPES,
  exportGraph,
  LINK_TYPES,
  NotFoundError,
  readRegistry,
  readyGateBlockers,
  resolveAuthoringSkills,
  DEFAULT_STATUS,
  seedProject,
  SqliteStore,
  WORK_ORDER_STATUSES,
  WORK_TYPES,
  writeRegistry,
  type Entity,
  type EntityType,
  type Id,
  type LinkType,
  type ProjectEntry,
  type Revision,
  type Store,
  type Suggestion,
  type WorkOrderStatus,
  type WorkType,
} from "@kiln/core";
import {
  acceptCandidate,
  assembleRefineContext,
  BLUEPRINT_TEMPLATE,
  draftSuggestion,
  extractWorkOrders,
  REQUIREMENT_TEMPLATE,
  reviewDocument,
  type DraftTemplate,
  type Finding,
  type ModelProvider,
  type WorkOrderCandidate,
} from "@kiln/agents";

// Command layer: every CLI verb is a plain function over (store, provider) so
// the scripted-run acceptance can be tested with an injected provider. The
// bin entry in index.ts only parses argv and prints.

function mustGet(store: Store, id: Id): Entity {
  const entity = store.getEntity(id);
  if (!entity) throw new NotFoundError(id);
  return entity;
}

export function runCreate(
  store: Store,
  type: string,
  title: string,
  body = "",
  workType?: string,
): Entity {
  if (!(ENTITY_TYPES as readonly string[]).includes(type)) {
    throw new ConstraintError(`unknown entity type "${type}" (expected: ${ENTITY_TYPES.join(", ")})`);
  }
  if (workType !== undefined && !(WORK_TYPES as readonly string[]).includes(workType)) {
    throw new ConstraintError(`unknown work type "${workType}" (expected: ${WORK_TYPES.join(", ")})`);
  }
  // The store enforces work_order-only, so --work-type on another entity type
  // surfaces as its ConstraintError.
  return store.createEntity({
    type: type as EntityType,
    title,
    body,
    ...(workType !== undefined ? { workType: workType as WorkType } : {}),
  });
}

export function runLink(store: Store, fromId: Id, toId: Id, type: string): void {
  if (!(LINK_TYPES as readonly string[]).includes(type)) {
    throw new ConstraintError(`unknown link type "${type}" (expected: ${LINK_TYPES.join(", ")})`);
  }
  store.link(fromId, toId, type as LinkType);
}

// The artifacts a draft must be grounded in: a requirement's own references,
// or — for a blueprint — the references of the requirement it details.
export function gatherArtifacts(store: Store, target: Entity): Entity[] {
  if (target.type === "requirement") return store.linked(target.id, "references");
  if (target.type === "blueprint") {
    const requirement = store.linked(target.id, "details")[0];
    return requirement ? store.linked(requirement.id, "references") : [];
  }
  return [];
}

export function templateFor(target: Entity): DraftTemplate {
  if (target.type === "requirement") return REQUIREMENT_TEMPLATE;
  if (target.type === "blueprint") return BLUEPRINT_TEMPLATE;
  throw new ConstraintError(`cannot draft into a ${target.type}; draft targets a requirement or blueprint`);
}

export async function runDraft(store: Store, provider: ModelProvider, entityId: Id): Promise<Suggestion> {
  const target = mustGet(store, entityId);
  const suggestion = await draftSuggestion(provider, {
    target,
    artifacts: gatherArtifacts(store, target),
    template: templateFor(target),
    skills: resolveAuthoringSkills(store),
  });
  store.saveSuggestion(suggestion);
  return suggestion;
}

export function runSuggestions(store: Store, entityId: Id): Suggestion[] {
  mustGet(store, entityId);
  return store.listSuggestions(entityId);
}

// Accept a suggestion. Without explicit indexes, every op is accepted.
export function runAccept(
  store: Store,
  suggestionId: Id,
  opIndexes?: number[],
): { entity: Entity; revision: Revision; appliedOps: number[] } {
  const suggestion = store.getSuggestion(suggestionId);
  if (!suggestion) throw new NotFoundError(suggestionId);
  const ops = opIndexes ?? suggestion.ops.map((_, i) => i);
  const result = applySuggestion(store, suggestionId, ops);
  return { ...result, appliedOps: ops };
}

export interface ExtractResult {
  candidates: WorkOrderCandidate[];
  accepted: Entity[];
}

// Extract candidates from a blueprint and accept the chosen subset in the
// same run (candidates are not persisted, so acceptance happens here).
export async function runExtract(
  store: Store,
  provider: ModelProvider,
  blueprintId: Id,
  accept: number[] | "all" | "none" = "none",
): Promise<ExtractResult> {
  const blueprint = mustGet(store, blueprintId);
  const candidates = await extractWorkOrders(provider, blueprint, {
    skills: resolveAuthoringSkills(store),
  });

  const indexes =
    accept === "all" ? candidates.map((_, i) => i) : accept === "none" ? [] : accept;
  for (const i of indexes) {
    if (!Number.isInteger(i) || i < 0 || i >= candidates.length) {
      throw new ConstraintError(`accepted candidate index out of range: ${i} (got ${candidates.length} candidates)`);
    }
  }
  const accepted = indexes.map((i) => acceptCandidate(store, blueprintId, candidates[i]));
  return { candidates, accepted };
}

export interface ReviewRunResult {
  findings: Finding[];
  /** Fix ops the model proposed, whether or not they were filed. */
  suggestion: Suggestion | null;
  /** True when --suggest filed the suggestion into the store. */
  filed: boolean;
}

// On-demand review (FRD Phase 5). Findings always come back; the proposed fix
// ops are only FILED when `suggest` is set, and filing obeys the one-pending-
// suggestion rule — the same anchor-lock stance as the chat route.
export async function runReview(
  store: Store,
  provider: ModelProvider,
  entityId: Id,
  suggest = false,
): Promise<ReviewRunResult> {
  // Throws NotFoundError for unknown ids and ConstraintError for non-document
  // targets (work orders, artifacts).
  const context = assembleRefineContext(store, entityId);
  const { findings, suggestion } = await reviewDocument(provider, context, {
    skills: resolveAuthoringSkills(store),
  });

  if (suggest && suggestion) {
    if (store.listSuggestions(entityId).length > 0) {
      throw new ConstraintError(
        "resolve pending suggestions first — this document already has one pending, and review ops anchor to the current body",
      );
    }
    store.saveSuggestion(suggestion);
    return { findings, suggestion, filed: true };
  }
  return { findings, suggestion, filed: false };
}

export function runSetStatus(store: Store, workOrderId: Id, status: string, opts?: { force?: boolean }): Entity {
  const entity = mustGet(store, workOrderId);
  if (entity.type !== "work_order") {
    throw new ConstraintError(`entity ${workOrderId} is a ${entity.type}, not a work_order`);
  }
  if (!(WORK_ORDER_STATUSES as readonly string[]).includes(status)) {
    throw new ConstraintError(`unknown status "${status}" (expected: ${WORK_ORDER_STATUSES.join(", ")})`);
  }
  // Completeness gate (methodology layer 3): draft→ready only; --force is the
  // CLI's explicit human override — same semantics as the sidecar's overrideGate.
  const from = entity.status ?? DEFAULT_STATUS;
  if (from === "draft" && status === "ready" && !opts?.force) {
    const blockers = readyGateBlockers(store, workOrderId);
    if (blockers.length > 0) {
      throw new ConstraintError(
        `Not ready — completeness gate: ${blockers.map((b) => b.code).join(", ")}. ` +
          `Fix these, or rerun with --force to set ready anyway.`,
      );
    }
  }
  return store.updateEntity(workOrderId, { status: status as WorkOrderStatus });
}

export function runShow(store: Store, entityId: Id): Entity {
  return mustGet(store, entityId);
}

export interface ExportRunResult {
  dir: string;
  fileCount: number;
  orphanCount: number;
}

// Write the whole graph as markdown (FRD Phase 5). core's exportGraph is pure;
// every filesystem effect lives here. A non-empty target is refused unless
// forced — exporting must never silently mingle with (or clobber) other files.
export function runExport(store: Store, dir: string, force = false): ExportRunResult {
  const target = resolve(dir);

  let existing: string[] = [];
  try {
    existing = readdirSync(target);
  } catch {
    // Missing directory is fine — created below.
  }
  if (existing.length > 0 && !force) {
    throw new ConstraintError(`target directory ${target} is not empty (use --force to export anyway)`);
  }

  const files = exportGraph(store);
  for (const file of files) {
    const path = join(target, file.relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.contents);
  }
  mkdirSync(target, { recursive: true }); // an empty store still yields the target dir

  return {
    dir: target,
    fileCount: files.length,
    orphanCount: files.filter((f) => f.relativePath.startsWith("unfiled/")).length,
  };
}

// Projects (multi-project workspaces): the CLI resolves its project at
// startup — per-process only, never synchronized with the app. All registry
// logic lives in core's projects module; these wrappers add the CLI's
// lookup-by-ref semantics and the seeded product root.

export interface ProjectsListResult {
  projects: ProjectEntry[];
  defaultProject: string | null;
}

export function runProjectsList(home?: string): ProjectsListResult {
  const registry = readRegistry(home);
  return { projects: registry.projects, defaultProject: registry.defaultProject };
}

// Registers a project and seeds its product root requirement + design-doc
// blueprint (named after the project) so the root conventions and the global
// design doc hold from the first minute — the same rule the desktop sidecar
// applies (shared seedProject helper).
export function runProjectsCreate(name: string, home?: string): ProjectEntry {
  const entry = createProject(name, { home });
  const seed = new SqliteStore(entry.dbPath);
  try {
    seedProject(seed, name);
  } finally {
    seed.close();
  }
  return entry;
}

const findProject = (registry: ProjectsListResult, ref: string): ProjectEntry | undefined =>
  registry.projects.find((p) => p.id === ref || p.slug === ref || p.name === ref);

// Sets the registry default — what every process without an explicit override
// opens next. Accepts id, slug, or exact name, like KILN_PROJECT/--project.
export function runProjectsUse(ref: string, home?: string): ProjectEntry {
  const registry = readRegistry(home);
  const entry = findProject(registry, ref);
  if (!entry) throw new NotFoundError(`project ${ref}`);
  writeRegistry({ ...registry, defaultProject: entry.id }, home);
  return entry;
}

// The single-invocation project override: `--project` becomes KILN_PROJECT for
// this process only, slotting into core's resolution order (KILN_DB_PATH still
// beats it; the registry default applies when neither is set).
export function cliEnv(base: NodeJS.ProcessEnv, projectRef?: string): NodeJS.ProcessEnv {
  return projectRef === undefined ? base : { ...base, KILN_PROJECT: projectRef };
}
