import { resolveDbPath, SqliteStore, type Entity, type NewEntity, type Store } from "@kiln/core";

export interface SeededChain {
  artifactId: string;
  requirementId: string;
  blueprintId: string;
  workOrderId: string;
}

// Find-or-create by (type, title) so re-running the seed against an existing
// store is a no-op instead of piling up duplicate demo entities.
function ensure(store: Store, input: NewEntity): Entity {
  const existing = store.listEntities(input.type).find((e) => e.title === input.title);
  return existing ?? store.createEntity(input);
}

// link() is INSERT OR IGNORE for most edge types, but `details` enforces the
// 1:1 rule and throws if the blueprint already details anything — so check
// before linking rather than relying on the insert being ignored.
function ensureLink(store: Store, fromId: string, toId: string, type: Parameters<Store["link"]>[2]): void {
  const existing = store.linked(fromId, type);
  if (type === "details" && existing.length > 0) return;
  if (existing.some((e) => e.id === toId)) return;
  store.link(fromId, toId, type);
}

// Insert a demo graph. The primary chain — artifact → requirement → blueprint
// → ready work order — is wired with the exact edges assembleWorkOrderContext
// walks:
//   work_order --implements--> blueprint --details--> requirement --references--> artifact
// Around it, a second feature (nested sub-requirement, its own blueprint, and
// work orders spread across board columns with depends_on edges — including a
// ready-but-blocked one, so dependency-aware readiness shows in a fresh demo)
// so the app has something realistic to show. Idempotent: re-seeding matches
// entities by (type, title) and re-uses them.
// Returns the primary chain's ids so callers (and tests) can drive the loop
// immediately.
export function seed(store: Store): SeededChain {
  // --- primary chain (exactly one `ready` work order) ---
  const artifact = ensure(store, {
    type: "artifact",
    title: "Kickoff transcript",
    body: "Founder: users keep losing the thread between why we built something and the code that shipped it.",
  });

  const requirement = ensure(store, {
    type: "requirement",
    title: "Traceable work handoff",
    body: "As a builder, I want a coding agent to pull a ready work order with its full linked context so nothing about the 'why' is lost.",
  });

  const blueprint = ensure(store, {
    type: "blueprint",
    title: "MCP work-order bridge",
    body: "Expose ready work orders over MCP with assembled context; validate status transitions; bearer auth.",
  });

  const workOrder = ensure(store, {
    type: "work_order",
    title: "Wire up the three MCP tools",
    body: "Implement list_ready_work_orders, get_work_order, and update_work_order_status over the shared Store.",
    status: "ready",
  });

  ensureLink(store, workOrder.id, blueprint.id, "implements");
  ensureLink(store, blueprint.id, requirement.id, "details");
  ensureLink(store, requirement.id, artifact.id, "references");

  // --- nested sub-requirement under the primary feature ---
  const subRequirement = ensure(store, {
    type: "requirement",
    title: "Agent status reporting",
    body: "As a builder, I want agents to report progress on a work order so the board reflects reality without me asking.",
  });
  ensureLink(store, subRequirement.id, requirement.id, "child_of");

  const statusWorkOrder = ensure(store, {
    type: "work_order",
    title: "Report agent status over MCP",
    body: "Extend update_work_order_status so agents can attach a progress note; surface it on the board card.",
    status: "draft",
  });
  ensureLink(store, statusWorkOrder.id, blueprint.id, "implements");

  // --- second feature: editor robustness ---
  const feedbackArtifact = ensure(store, {
    type: "artifact",
    title: "Editor feedback notes",
    body: "Support thread: two users lost edits when the app crashed mid-session; one asked to see what changed between saves.",
  });

  const editorRequirement = ensure(store, {
    type: "requirement",
    title: "Robust document editing",
    body: "As a writer, I never want to lose work — edits should survive crashes and I should be able to see and restore past versions.",
  });
  ensureLink(store, editorRequirement.id, feedbackArtifact.id, "references");

  const editorBlueprint = ensure(store, {
    type: "blueprint",
    title: "Editor autosave & recovery",
    body: "Debounced autosave through commitBody; a revision per commit; restore any revision from history on relaunch.",
  });
  ensureLink(store, editorBlueprint.id, editorRequirement.id, "details");

  const autosaveWorkOrder = ensure(store, {
    type: "work_order",
    title: "Autosave document drafts",
    body: "Debounce editor changes and commit through commitBody so every save lands a revision.",
    status: "done",
  });
  ensureLink(store, autosaveWorkOrder.id, editorBlueprint.id, "implements");

  const recoveryWorkOrder = ensure(store, {
    type: "work_order",
    title: "Recover unsaved changes on relaunch",
    body: "On startup, diff the last revision against the stored body and offer a restore.",
    status: "in_progress",
  });
  ensureLink(store, recoveryWorkOrder.id, editorBlueprint.id, "implements");
  ensureLink(store, recoveryWorkOrder.id, autosaveWorkOrder.id, "depends_on");

  // A ready-but-BLOCKED work order: it depends on the recovery work, which is
  // still in_progress. This makes dependency-aware readiness visible in a
  // fresh demo — list_ready_work_orders withholds it and the board shows the
  // BLOCKED badge — leaving the primary chain's work order as the single
  // unblocked ready one.
  const historyWorkOrder = ensure(store, {
    type: "work_order",
    title: "Browse and restore revision history",
    body: "Add a history browser to the editor: list revisions, diff each against the current body, restore any of them.",
    status: "ready",
  });
  ensureLink(store, historyWorkOrder.id, editorBlueprint.id, "implements");
  ensureLink(store, historyWorkOrder.id, recoveryWorkOrder.id, "depends_on");

  return {
    artifactId: artifact.id,
    requirementId: requirement.id,
    blueprintId: blueprint.id,
    workOrderId: workOrder.id,
  };
}

// CLI entry: seed the store at KILN_DB_PATH and print the ready work order id.
function main(): void {
  const dbPath = resolveDbPath();
  const store = new SqliteStore(dbPath);
  try {
    const chain = seed(store);
    console.error(`Seeded demo graph into ${dbPath} (idempotent — existing entities re-used)`);
    // The work order id goes to stdout so it can be captured by a script.
    console.log(chain.workOrderId);
  } finally {
    store.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
