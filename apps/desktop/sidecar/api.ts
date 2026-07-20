import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  activityTimeline,
  allowedNextStatuses,
  ancestors,
  applySuggestion,
  assembleWorkOrderContext,
  blockingDependencies,
  canTransition,
  ConstraintError,
  contextHealth,
  criticalPath,
  DEFAULT_STATUS,
  documentHealth,
  EditError,
  ENTITY_TYPES,
  featureTree,
  graphGaps,
  graphSnapshot,
  knowledgeHealth,
  LINK_TYPES,
  NotFoundError,
  projectPulse,
  readAuthoringSkillDocs,
  readyGateBlockers,
  resolveAuthoringSkills,
  writeAuthoringSkillDocs,
  Suggestion,
  usageReport,
  WORK_ORDER_STATUSES,
  type Entity,
  type ModelUsageFeature,
  type Store,
} from "@kiln/core";
import {
  acceptCandidate,
  AnthropicModelProvider,
  assembleRefineContext,
  BLUEPRINT_TEMPLATE,
  draftSuggestion,
  extractWorkOrders,
  refineTurn,
  REQUIREMENT_TEMPLATE,
  reviewDocument,
  withUsageRecording,
  WorkOrderCandidate,
  type DraftTemplate,
  type ModelProvider,
} from "@kiln/agents";
import type { ProjectManager } from "./projects.js";

// The sidecar API: a thin HTTP veneer over the core Store. Every route is a
// direct call into core — no product logic lives here or in the webview
// (BP-5). This is the same host surface a future self-host server would use.

const CreateEntity = z.object({
  type: z.enum(ENTITY_TYPES),
  title: z.string().min(1),
  body: z.string().default(""),
});

const PatchEntity = z.object({
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  status: z.enum(WORK_ORDER_STATUSES).nullable().optional(),
  assignee: z.string().nullable().optional(),
});

const CreateLink = z.object({
  fromId: z.string().min(1),
  toId: z.string().min(1),
  type: z.enum(LINK_TYPES),
});

const ProjectName = z.object({ name: z.string().trim().min(1) });

// AI settings live under fixed keys in the store's settings table (AI
// settings & usage). The raw key is written here and read by createProvider —
// it must NEVER appear in an HTTP response; reads return hasKey + keyTail.
const AI_SETTING_KEYS = {
  apiKey: "ai.apiKey",
  provider: "ai.provider",
  enabled: "ai.enabled",
} as const;

// Partial update: only the fields present change. `apiKey: null` removes the
// stored key (env fallback applies again); `provider` is a forward-looking
// control — Anthropic is the only accepted value today.
const PutAiSettings = z.object({
  apiKey: z.string().min(1).nullable().optional(),
  provider: z.literal("anthropic").optional(),
  enabled: z.boolean().optional(),
});

// Authoring skills are settings documents (2026-07-13 reversal): full
// {id, title, body, enabled} docs travel both ways. Array order = injection
// order; `enabled` is the switch. Skills live only in Settings — no entity
// route ever touches them.
const PutAuthoringSkills = z.array(
  z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    body: z.string(),
    enabled: z.boolean(),
  }),
);

// A refine chat request (BP-4): the session transcript so far, oldest first,
// ending with the author's new user turn. Transcripts are session-local — the
// webview owns them and posts the whole history each turn; nothing persists.
const ChatRequest = z.object({
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1) }))
    .min(1),
});

// Which artifacts ground a draft, and which template shapes it — mirrors the
// CLI's selection: a requirement drafts from its own references; a blueprint
// drafts from the references of the requirement it details.
function gatherArtifacts(store: Store, target: Entity): Entity[] {
  if (target.type === "requirement") return store.linked(target.id, "references");
  if (target.type === "blueprint") {
    const requirement = store.linked(target.id, "details")[0];
    return requirement ? store.linked(requirement.id, "references") : [];
  }
  return [];
}

function templateFor(target: Entity): DraftTemplate {
  if (target.type === "requirement") return REQUIREMENT_TEMPLATE;
  if (target.type === "blueprint") return BLUEPRINT_TEMPLATE;
  throw new ConstraintError(`cannot draft into a ${target.type}; draft targets a requirement or blueprint`);
}

// The model key lives only in this host process (BP-4). `createProvider` is
// injectable so tests supply a scripted provider; the default constructs the
// Anthropic provider lazily, and a missing key surfaces as a 503 at call time
// rather than crashing the sidecar at boot.
export interface ApiDeps {
  createProvider?: () => ModelProvider;
  /**
   * Injection seam for testing key RESOLUTION: called with the settings-stored
   * key, or null when none is stored (→ host-env fallback). The default
   * constructs the real Anthropic provider either way. Ignored when
   * `createProvider` is supplied.
   */
  providerForKey?: (apiKey: string | null) => ModelProvider;
  /**
   * The project manager (Projects feature). When present, the /projects
   * routes are registered and `store` should be the manager's active-store
   * proxy. Absent (tests passing a bare store), the sidecar behaves exactly
   * as before the feature.
   */
  projects?: ProjectManager;
}

export function buildApi(store: Store, deps: ApiDeps = {}): Hono {
  const app = new Hono();
  // Resolution order: a key saved in Settings beats the host env — the whole
  // point of in-app settings is escaping dotfile edits and restarts. No stored
  // key falls back to the env-resolved client (previous behavior).
  const providerForKey =
    deps.providerForKey ??
    ((apiKey: string | null) =>
      apiKey === null ? new AnthropicModelProvider() : new AnthropicModelProvider({ apiKey }));
  const createProvider = deps.createProvider ?? (() => providerForKey(store.getSetting(AI_SETTING_KEYS.apiKey)));
  const aiEnabled = () => store.getSetting(AI_SETTING_KEYS.enabled) !== "false";
  // The masked settings view: everything the webview may know about the key.
  const aiSettings = () => {
    const key = store.getSetting(AI_SETTING_KEYS.apiKey);
    return {
      provider: store.getSetting(AI_SETTING_KEYS.provider) ?? "anthropic",
      enabled: aiEnabled(),
      hasKey: key !== null,
      keyTail: key === null ? null : key.slice(-4),
    };
  };

  // The webview talks to us from the Vite/Tauri origin; localhost-only bind
  // plus permissive CORS is the BP-5 process model.
  app.use("*", cors());

  // Map domain errors to HTTP statuses in one place.
  app.onError((err, c) => {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof ConstraintError || err instanceof EditError || err instanceof z.ZodError) {
      return c.json({ error: err.message }, 400);
    }
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  // `providerAvailable` mirrors the 503 semantics of the authoring routes:
  // can a model provider be constructed from this host's config? No model
  // call is made — this is what the UI's credential status dot renders.
  app.get("/health", (c) => {
    let providerAvailable = true;
    try {
      createProvider();
    } catch {
      providerAvailable = false;
    }
    return c.json({ ok: true, providerAvailable, aiEnabled: aiEnabled() });
  });

  // AI settings (AI settings & usage): the masked config surface. GET never
  // includes the raw key; PUT accepts it and echoes only the masked view.
  app.get("/settings/ai", (c) => c.json(aiSettings()));

  app.put("/settings/ai", async (c) => {
    const patch = PutAiSettings.parse(await c.req.json());
    if (patch.apiKey === null) store.deleteSetting(AI_SETTING_KEYS.apiKey);
    else if (patch.apiKey !== undefined) store.setSetting(AI_SETTING_KEYS.apiKey, patch.apiKey);
    if (patch.provider !== undefined) store.setSetting(AI_SETTING_KEYS.provider, patch.provider);
    if (patch.enabled !== undefined) store.setSetting(AI_SETTING_KEYS.enabled, String(patch.enabled));
    return c.json(aiSettings());
  });

  // The authoring-skill switchboard: full skill documents under
  // kiln.authoring.skills. Reads tolerate malformed/legacy values as empty
  // (core's readAuthoringSkillDocs owns that rule).
  app.get("/settings/authoring-skills", (c) => c.json(readAuthoringSkillDocs(store)));

  // PUT persists the documents verbatim, deduping repeated ids first-wins;
  // the persisted array is echoed back.
  app.put("/settings/authoring-skills", async (c) => {
    const docs = PutAuthoringSkills.parse(await c.req.json());
    const seen = new Set<string>();
    const deduped = docs.filter((d) => {
      if (seen.has(d.id)) return false;
      seen.add(d.id);
      return true;
    });
    writeAuthoringSkillDocs(store, deduped);
    return c.json(deduped);
  });

  // The usage report over the whole ledger. Read-only — viewing usage records
  // nothing; only real model calls append entries (via withProvider below).
  app.get("/usage", (c) => c.json(usageReport(store.listModelUsage(), { now: new Date() })));

  // ?type=requirement lists a type; ?status=ready lists work orders by status.
  app.get("/entities", (c) => {
    const status = c.req.query("status");
    if (status !== undefined) {
      return c.json(store.workOrdersByStatus(z.enum(WORK_ORDER_STATUSES).parse(status)));
    }
    return c.json(store.listEntities(z.enum(ENTITY_TYPES).parse(c.req.query("type"))));
  });

  app.post("/entities", async (c) => {
    const input = CreateEntity.parse(await c.req.json());
    return c.json(store.createEntity(input), 201);
  });

  app.get("/entities/:id", (c) => {
    const entity = store.getEntity(c.req.param("id"));
    if (!entity) throw new NotFoundError(c.req.param("id"));
    return c.json(entity);
  });

  app.patch("/entities/:id", async (c) => {
    const id = c.req.param("id");
    const raw = (await c.req.json()) as Record<string, unknown>;
    // The explicit human override for the draft→ready completeness gate.
    // Read before PatchEntity.parse (Zod strips unknown keys).
    const overrideGate = raw?.overrideGate === true;
    const patch = PatchEntity.parse(raw);

    // A status change on a work order must obey the BP-3 lifecycle — the same
    // rule the MCP bridge enforces, now shared via @kiln/core.
    if (patch.status !== undefined && patch.status !== null) {
      const entity = store.getEntity(id);
      if (!entity) throw new NotFoundError(id);
      if (entity.type !== "work_order") {
        throw new ConstraintError(`entity ${id} is a ${entity.type}, not a work_order`);
      }
      const from = entity.status ?? DEFAULT_STATUS;
      if (from !== patch.status && !canTransition(from, patch.status)) {
        throw new ConstraintError(
          `Invalid status transition ${from} → ${patch.status}. ` +
            `Allowed from ${from}: ${allowedNextStatuses(from).join(", ") || "(none — terminal)"}.`,
        );
      }
      // Completeness gate (methodology layer 3): draft→ready only, overridable.
      if (from === "draft" && patch.status === "ready" && !overrideGate) {
        const blockers = readyGateBlockers(store, id);
        if (blockers.length > 0) {
          throw new ConstraintError(
            `Not ready — completeness gate: ${blockers.map((b) => b.code).join(", ")}. ` +
              `Fix these, or pass overrideGate: true to set ready anyway.`,
          );
        }
      }
    }
    return c.json(store.updateEntity(id, patch));
  });

  // The whole knowledge graph in one call (Phase 7 — Project X-ray): typed
  // nodes (with rolled-up progress) + edges, so the Map view loads without N
  // per-entity requests.
  app.get("/graph", (c) => c.json(graphSnapshot(store)));
  // X-ray diagnostic overlays (Phase 7): structural dead-ends and the critical
  // path of remaining work. Blocked state reuses /work-orders/readiness below.
  app.get("/graph/gaps", (c) => c.json(graphGaps(store)));
  app.get("/graph/critical-path", (c) => c.json({ path: criticalPath(store) }));

  // Project Pulse reads (Phase 10): the whole-project dashboard in three
  // calls — health rollup, knowledge/context readiness, recent activity.
  // Read-only: viewing is not a handoff, so none of these record a receipt.
  app.get("/pulse", (c) => c.json(projectPulse(store)));
  app.get("/pulse/knowledge", (c) => c.json(knowledgeHealth(store)));
  app.get("/pulse/activity", (c) => {
    const limit = c.req.query("limit");
    return c.json(
      activityTimeline(store, limit === undefined ? undefined : z.coerce.number().int().positive().parse(limit)),
    );
  });

  // Dependency readiness for every work order in one call (WO-B2): the board
  // joins this client-side instead of issuing a query per card. `blocking`
  // carries enough (id/title/status) for a badge tooltip and click-through;
  // the readiness POLICY stays in core's blockingDependencies.
  app.get("/work-orders/readiness", (c) =>
    c.json(
      store.listEntities("work_order").map((w) => {
        const blocking = blockingDependencies(store, w.id).map((d) => ({
          id: d.id,
          title: d.title,
          status: d.status,
        }));
        return { id: w.id, blocked: blocking.length > 0, blocking };
      }),
    ),
  );

  // The statuses a work order may legally move to (board renders only these).
  app.get("/entities/:id/transitions", (c) => {
    const entity = store.getEntity(c.req.param("id"));
    if (!entity) throw new NotFoundError(c.req.param("id"));
    const current = entity.status ?? DEFAULT_STATUS;
    return c.json({ current, allowed: allowedNextStatuses(current) });
  });

  app.delete("/entities/:id", (c) => {
    store.deleteEntity(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/entities/:id/subtree", (c) => c.json(store.subtree(c.req.param("id"))));

  // child_of ancestry, nearest parent first (breadcrumbs reverse it).
  app.get("/entities/:id/ancestors", (c) => c.json(ancestors(store, c.req.param("id"))));

  // The nested requirement tree for the navigator (BP-5). ?expand=chain also
  // nests each requirement's blueprints and their work orders (BP-6).
  app.get("/tree", (c) => {
    const expand = c.req.query("expand");
    return c.json(featureTree(store, expand === undefined ? {} : { expand: z.literal("chain").parse(expand) }));
  });

  // Graph edges around one entity, both directions.
  app.get("/entities/:id/linked/:type", (c) =>
    c.json(store.linked(c.req.param("id"), z.enum(LINK_TYPES).parse(c.req.param("type")))),
  );
  app.get("/entities/:id/linked-from/:type", (c) =>
    c.json(store.linkedFrom(c.req.param("id"), z.enum(LINK_TYPES).parse(c.req.param("type")))),
  );

  app.get("/entities/:id/context", (c) =>
    c.json(assembleWorkOrderContext(store, c.req.param("id"))),
  );

  // Context Assembly Inspector reads (Phase 8): the pre-flight health report
  // and the recorded handoff receipts. Read-only — viewing is not a handoff, so
  // these never record a receipt (only get_work_order over MCP does).
  app.get("/entities/:id/context/health", (c) =>
    c.json(contextHealth(assembleWorkOrderContext(store, c.req.param("id")))),
  );
  app.get("/entities/:id/context/receipts", (c) =>
    c.json(store.listContextReceipts(c.req.param("id"))),
  );

  // Per-document authoring-standards checks (methodology layer 2). Read-only,
  // any entity type; reports, never blocks.
  app.get("/entities/:id/health", (c) => c.json(documentHealth(store, c.req.param("id"))));

  // Suggestions + revisions (WO-15): staged per-op decisions resolve through
  // core's applySuggestion; a full rejection dismisses the suggestion.
  app.get("/entities/:id/suggestions", (c) => c.json(store.listSuggestions(c.req.param("id"))));
  app.get("/entities/:id/revisions", (c) => c.json(store.listRevisions(c.req.param("id"))));

  // Restore a past revision (BP-6): writes through commitBody, which is
  // exempt from the anchor lock and appends exactly one new revision.
  app.post("/entities/:id/restore", async (c) => {
    const id = c.req.param("id");
    const { revisionId } = z.object({ revisionId: z.string().min(1) }).parse(await c.req.json());
    const revision = store.listRevisions(id).find((r) => r.id === revisionId);
    if (!revision) throw new NotFoundError(revisionId);
    return c.json(store.commitBody(id, revision.body));
  });

  app.post("/suggestions", async (c) => {
    const suggestion = Suggestion.parse({ id: randomUUID(), ...(await c.req.json()) });
    // Anchor lock (WO-C1): ops anchor to the current body, and the editor
    // resolves one pending suggestion at a time — refuse to stack a second.
    if (store.listSuggestions(suggestion.targetId).length > 0) {
      throw new ConstraintError(
        "resolve pending suggestions first — this document already has one pending, and new ops anchor to the current body",
      );
    }
    store.saveSuggestion(suggestion);
    return c.json(suggestion, 201);
  });

  app.post("/suggestions/:id/apply", async (c) => {
    const { acceptedOpIndexes } = z
      .object({ acceptedOpIndexes: z.array(z.number().int().nonnegative()).min(1) })
      .parse(await c.req.json());
    return c.json(applySuggestion(store, c.req.param("id"), acceptedOpIndexes));
  });

  app.delete("/suggestions/:id", (c) => {
    store.deleteSuggestion(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/links", async (c) => {
    const { fromId, toId, type } = CreateLink.parse(await c.req.json());
    store.link(fromId, toId, type);
    return c.json({ ok: true }, 201);
  });

  // Agent-assisted authoring (BP-4), run host-side so the model key never
  // reaches the webview. Provider construction/first-call failures (usually a
  // missing key) become a 503 with a clear message. This is the single choke
  // point for model access, so the AI kill switch and the usage ledger both
  // live here: disabled → 503 before any provider exists, and every provider
  // is wrapped so each successful model call lands in the ledger tagged with
  // the route's feature.
  const withProvider = async <T>(c: Context, feature: ModelUsageFeature, run: (p: ModelProvider) => Promise<T>) => {
    if (!aiEnabled()) {
      return c.json({ error: "AI features are disabled in Settings — turn them back on to use agent-assisted authoring." }, 503);
    }
    let provider: ModelProvider;
    try {
      provider = withUsageRecording(createProvider(), (usage) => store.recordModelUsage({ feature, ...usage }));
    } catch (err) {
      return c.json({ error: `model provider unavailable: ${err instanceof Error ? err.message : String(err)}` }, 503);
    }
    try {
      return c.json(await run(provider));
    } catch (err) {
      // Domain errors keep their HTTP semantics (bad target id / wrong type).
      if (err instanceof NotFoundError || err instanceof ConstraintError || err instanceof z.ZodError) throw err;
      // Everything else — DraftError/ExtractError, or a raw model/SDK/network
      // failure (including a missing API key surfacing at request time) — is a
      // bad-gateway to the model. Report the underlying message, not "internal
      // error".
      return c.json({ error: `authoring failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
    }
  };

  app.post("/entities/:id/draft", (c) =>
    withProvider(c, "draft", async (provider) => {
      const target = store.getEntity(c.req.param("id"));
      if (!target) throw new NotFoundError(c.req.param("id"));
      const suggestion = await draftSuggestion(provider, {
        target,
        artifacts: gatherArtifacts(store, target),
        template: templateFor(target),
        skills: resolveAuthoringSkills(store),
      });
      store.saveSuggestion(suggestion);
      return suggestion;
    }),
  );

  app.post("/entities/:id/extract", (c) =>
    withProvider(c, "extract", async (provider) => {
      const blueprint = store.getEntity(c.req.param("id"));
      if (!blueprint) throw new NotFoundError(c.req.param("id"));
      const candidates = await extractWorkOrders(provider, blueprint, {
        skills: resolveAuthoringSkills(store),
      });
      return { candidates };
    }),
  );

  // Conversational refinement (BP-4): chat scoped to one document. The reply is
  // prose and/or a filed suggestion — the same per-op accept/reject machinery as
  // draft. 503/502 mapping is shared via withProvider; a wrong-type target or a
  // pending-suggestion conflict surfaces as a 400 ConstraintError with copy the
  // UI shows verbatim.
  app.post("/entities/:id/chat", (c) =>
    withProvider(c, "chat", async (provider) => {
      const id = c.req.param("id");
      if (!store.getEntity(id)) throw new NotFoundError(id);
      const { messages } = ChatRequest.parse(await c.req.json());
      // Throws ConstraintError for a work_order/artifact target.
      const context = assembleRefineContext(store, id);
      const { text, suggestion } = await refineTurn(provider, context, messages, {
        skills: resolveAuthoringSkills(store),
      });
      if (suggestion) {
        // Anchor lock: the editor resolves one pending suggestion at a time, and
        // its ops are anchored to the current body. Refuse to stack a second.
        if (store.listSuggestions(id).length > 0) {
          throw new ConstraintError(
            "This document already has a pending suggestion — apply or dismiss it before the agent proposes another edit.",
          );
        }
        store.saveSuggestion(suggestion);
      }
      return { reply: text, suggestionId: suggestion?.id };
    }),
  );

  // On-demand review (WO-C1): findings + proposed fix ops. Nothing is filed
  // here — the UI's "propose fixes" posts the ops to /suggestions, so the
  // human gates the edit exactly like extract candidates. 503/502 via
  // withProvider; wrong-type targets 400 through assembleRefineContext.
  app.post("/entities/:id/review", (c) =>
    withProvider(c, "review", async (provider) => {
      const id = c.req.param("id");
      if (!store.getEntity(id)) throw new NotFoundError(id);
      const context = assembleRefineContext(store, id);
      const { findings, suggestion } = await reviewDocument(provider, context, {
        skills: resolveAuthoringSkills(store),
      });
      return { findings, ops: suggestion?.ops ?? null };
    }),
  );

  // Accept an extracted candidate: creates a draft work_order linked
  // implements → blueprint. Separate from extract so the human gates it.
  app.post("/entities/:id/work-orders", async (c) => {
    const candidate = WorkOrderCandidate.parse(await c.req.json());
    return c.json(acceptCandidate(store, c.req.param("id"), candidate), 201);
  });

  // Projects (registry + active-store swap). The routes are thin veneers over
  // the manager; activation is the ONLY way the active store changes — no
  // route takes a per-request project override. The manager throws core
  // domain errors, so the shared onError mapping applies.
  if (deps.projects) {
    const projects = deps.projects;

    app.get("/projects", (c) => c.json(projects.list()));

    app.post("/projects", async (c) => {
      const { name } = ProjectName.parse(await c.req.json());
      return c.json(projects.create(name), 201);
    });

    app.post("/projects/:id/activate", (c) => c.json(projects.activate(c.req.param("id"))));

    app.patch("/projects/:id", async (c) => {
      const { name } = ProjectName.parse(await c.req.json());
      return c.json(projects.rename(c.req.param("id"), name));
    });

    app.delete("/projects/:id", (c) => {
      projects.remove(c.req.param("id"));
      return c.json({ ok: true });
    });
  }

  return app;
}
