# Kiln — Blueprint (Technical Design)

This blueprint is one-to-one with `requirements.md`. BP-0 is the foundation (cross-cutting
decisions); BP-1…BP-5 detail each feature. Code shapes below are contracts to build against,
not final implementations — types and signatures should hold; internals are yours.

---

## BP-0 — Foundation

### Stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript (strict) | Shared `tsconfig.base.json`. |
| Monorepo | pnpm workspaces | Strict dep isolation keeps the `core`/host boundary honest. Add Turborepo later if builds hurt. |
| Lib build | tsup (esbuild) | Emits ESM + CJS + `.d.ts`; `core` is imported by three hosts. |
| Tests | Vitest | Same esbuild pipeline as the build. |
| DB | SQLite via `better-sqlite3` | Synchronous, fast, local. **Native addon → cannot run in the Tauri webview** (see BP-5). |
| ORM / migrations | Drizzle + drizzle-kit | Plain-TS schema, readable SQL migrations, dual-dialect capable. |
| Validation | Zod | At every boundary: store inputs, MCP tool args, model outputs. |
| Model access | Anthropic TS SDK behind `ModelProvider` | Structured output via tool-use; model tiering by config. |
| MCP | `@modelcontextprotocol/sdk` | Streamable HTTP transport; bearer-token auth. *Confirm current transport/auth API when building — fastest-moving dep.* |
| App shell | Tauri v2 + compiled Node sidecar | Sidecar runs `core` + a local Hono API; webview talks to it over localhost. |
| App ↔ core wire | Hono (HTTP) + typed client | Same host code powers the sidecar and any future self-host server. |
| UI | React + Vite + TanStack Query | Optimistic updates for accept/reject. |
| Editor | CodeMirror 6 (decorations) | Start here. Graduate to ProseMirror/TipTap when rich structured docs are needed. |

### Repository layout

```
kiln/
├─ pnpm-workspace.yaml
├─ turbo.json                    # optional, add later
├─ tsconfig.base.json
├─ packages/
│  ├─ core/                      # framework-free library — the product
│  │  ├─ src/
│  │  │  ├─ domain/              # entity + edit-op types (Zod)
│  │  │  ├─ schema/              # Drizzle tables + migrations
│  │  │  ├─ store/               # Store interface + SqliteStore
│  │  │  ├─ graph/               # traversal + assembleWorkOrderContext
│  │  │  ├─ edits/               # EditOp application engine + revisions
│  │  │  ├─ seams/               # AuthProvider, Authorizer, AuditSink (+ basic impls)
│  │  │  └─ index.ts
│  │  └─ package.json
│  ├─ agents/                    # ModelProvider + drafting/extraction workflows
│  ├─ mcp-server/                # MCP host over core.Store
│  └─ cli/                       # authoring CLI (Phase 2)
└─ apps/
   └─ desktop/                   # Tauri app + Node sidecar (Phase 3)
```

### Conventions (the rules that keep this coherent)

1. **No logic in hosts.** All business logic lives in `packages/core`. The MCP server, the
   CLI, and the desktop sidecar are thin adapters that inject a `Store`, a `ModelProvider`,
   an `AuthProvider`, etc. A host that contains a graph query or an edit rule is a bug.
2. **Everything through the `Store` interface.** No consumer imports Drizzle or
   `better-sqlite3`. Dialect-specific SQL (including FTS5) is confined to `SqliteStore`.
3. **Zod at every boundary.** Parse-don't-validate at: store writes, MCP tool args, and
   model outputs. Rejected input never reaches persistence.
4. **Structured edits only.** Documents are never overwritten wholesale. Changes are
   `EditOp[]`; applying them writes a `revision`.
5. **Seams are interfaces, impls are swappable.** `core` ships basic impls (local auth,
   allow-all authz, no-op audit). It never imports the (future) enterprise impls.

### Core domain types (`core/src/domain`)

```ts
export type Id = string;                       // ULID
export type EntityType = "artifact" | "requirement" | "blueprint" | "work_order";
export type LinkType   = "implements" | "details" | "references" | "child_of" | "depends_on";
export type WorkOrderStatus = "draft" | "ready" | "in_progress" | "done" | "cancelled";

export interface Entity {
  id: Id;
  type: EntityType;
  title: string;
  body: string;                                // document content (markdown)
  status?: WorkOrderStatus;                     // work_order only
  assignee?: string | null;                     // work_order only
  createdAt: string;
  updatedAt: string;
}

export interface Link { fromId: Id; toId: Id; type: LinkType; }
```

### Edit model (`core/src/domain`, engine in `core/src/edits`)

```ts
import { z } from "zod";

export const EditOp = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("insert"),  anchor: z.string(), text: z.string() }),
  z.object({ kind: z.literal("delete"),  anchor: z.string() }),
  z.object({ kind: z.literal("replace"), anchor: z.string(), text: z.string() }),
]);
export type EditOp = z.infer<typeof EditOp>;

export const Suggestion = z.object({
  id: z.string(),
  targetId: z.string(),                         // entity being edited
  ops: z.array(EditOp).min(1),
  source: z.enum(["draft_agent", "extract_agent", "human"]),
});
export type Suggestion = z.infer<typeof Suggestion>;
```

- `anchor` addresses a stable block within the document (e.g. a heading slug or block id).
- Accepting a suggestion applies its ops atomically and writes one immutable `revision`
  (a full snapshot of the resulting body). Individual ops may be accepted/rejected; the
  revision reflects only what was applied.

---

## BP-1 — Knowledge graph store

**Requirement:** FRD-1

### Drizzle schema (`core/src/schema`)

Four logical concerns → tables:

- `entities(id, type, title, body, status, assignee, created_at, updated_at)`
- `links(from_id, to_id, type)` — composite PK `(from_id, to_id, type)`; indexed both ways.
- `suggestions(id, target_id, source, ops_json, created_at)` — pending edits.
- `revisions(id, entity_id, body, created_at)` — immutable history.
- `entities_fts` — FTS5 virtual table over artifact/document text.

On connect, set:

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

### Store interface (`core/src/store`)

```ts
export interface Store {
  // entities
  createEntity(input: NewEntity): Entity;
  getEntity(id: Id): Entity | null;
  updateEntity(id: Id, patch: Partial<Pick<Entity,"title"|"body"|"status"|"assignee">>): Entity;

  // links
  link(fromId: Id, toId: Id, type: LinkType): void;
  unlink(fromId: Id, toId: Id, type: LinkType): void;
  linked(id: Id, type: LinkType): Entity[];      // entities `to` where (id -> to, type)
  linkedFrom(id: Id, type: LinkType): Entity[];  // entities `from` where (from -> id, type)

  // feature tree (child_of edges point child -> parent)
  children(parentId: Id): Entity[];
  subtree(rootId: Id): Entity[];                 // recursive CTE

  // work orders
  workOrdersByStatus(status: WorkOrderStatus): Entity[];

  // suggestions + revisions
  saveSuggestion(s: Suggestion): void;
  listSuggestions(targetId: Id): Suggestion[];
  applySuggestion(suggestionId: Id, acceptedOpIndexes: number[]): Entity; // writes a revision
  listRevisions(entityId: Id): Revision[];

  // artifacts
  searchArtifacts(query: string): Entity[];      // FTS5
}
```

`SqliteStore implements Store`. All FTS5 and recursive-CTE SQL lives here and nowhere else,
so a future `PostgresStore` is a drop-in.

### Link direction reference

| Edge | Direction | Meaning |
|---|---|---|
| `implements` | work_order → blueprint | the WO implements the blueprint |
| `details` | blueprint → requirement | the blueprint details the requirement (1:1) |
| `references` | requirement → artifact | the requirement draws on the artifact |
| `child_of` | requirement → requirement | feature-tree nesting |
| `depends_on` | work_order → work_order | sequencing |

---

## BP-2 — Context assembly

**Requirement:** FRD-2 · **Module:** `core/src/graph`

```ts
export interface WorkOrderContext {
  workOrder: Entity;
  blueprint: Entity | null;
  requirement: Entity | null;
  artifacts: Entity[];
}

export function assembleWorkOrderContext(store: Store, id: Id): WorkOrderContext {
  const workOrder = store.getEntity(id);
  if (!workOrder) throw new NotFound(id);
  const blueprint   = store.linked(id, "implements")[0] ?? null;
  const requirement = blueprint ? store.linked(blueprint.id, "details")[0] ?? null : null;
  const artifacts   = requirement ? store.linked(requirement.id, "references") : [];
  return { workOrder, blueprint, requirement, artifacts };
}
```

Also provide `ancestors(store, requirementId)` and `descendants(store, requirementId)` over
`child_of`. Everything here is pure read; no writes. Test against seeded fixtures asserting
the exact `WorkOrderContext` shape, including the missing-link partial cases.

---

## BP-3 — MCP work-order bridge

**Requirement:** FRD-3 · **Package:** `packages/mcp-server`

A standalone Node process. Opens the same SQLite file as the app (WAL makes this safe),
constructs a `SqliteStore`, and serves three tools over streamable HTTP with bearer auth.

### Tool contracts

```ts
// list_ready_work_orders() -> { id, title, summary }[]
//   summary = first ~200 chars of the work order body.

// get_work_order({ id }) -> WorkOrderContext (from BP-2), serialized.

// update_work_order_status({ id, status })
//   status ∈ WorkOrderStatus; validated against allowed transitions:
//   draft→ready, ready→in_progress, in_progress→done, *→cancelled.
```

- Tool args are Zod-parsed; invalid args return a tool error, never a throw.
- Auth: a bearer token from env; the MCP client config supplies it. Reject unauthenticated
  calls.
- Ship a `seed` script that inserts a demo chain (artifact → requirement → blueprint →
  ready work order) and prints the work order id.

### Verification (WO-07)

Document the exact steps to register the server with Claude Code, then: `list_ready_work_orders`
→ `get_work_order(id)` (confirm full context) → implement → `update_work_order_status(id,"done")`
→ confirm the store reflects `done`.

---

## BP-4 — Agent-assisted authoring

**Requirement:** FRD-4 · **Package:** `packages/agents`

### Model provider

```ts
export interface ModelProvider {
  complete(req: {
    system: string;
    messages: Message[];
    tools?: Tool[];              // structured output via a single "emit" tool
    tier: "reason" | "light";    // reason = drafting/extraction; light = classification
  }): Promise<ModelResult>;
}
```

`AnthropicModelProvider implements ModelProvider`. Tier → model id is a config map (a capable
model for `reason`, a cheap/fast one for `light`). The API key lives only in the host
process, never in the client/UI.

### Drafting agent

Input: a target entity (requirement or blueprint), its referenced artifacts, and a template
(house style). Output: a `Suggestion` of `EditOp[]` against the target's anchors. Force
structured output by giving the model an `emit_suggestion` tool whose schema is the `EditOp`
union; Zod-parse the tool call; reject and retry on malformed output.

### Extraction agent

Input: a blueprint. Output: candidate work orders (title + body) as a suggestion set.
Accepting a candidate creates a `work_order` entity and links it `implements → blueprint`.

### Edit engine (`core/src/edits`)

`applySuggestion(store, suggestionId, acceptedOpIndexes)` applies the accepted ops to the
target body in order, writes the updated entity, and appends a `revision`. Atomic: either the
whole accepted set applies and a revision is written, or nothing changes.

### Authoring CLI (`packages/cli`)

Commands: `kiln draft <entityId>`, `kiln extract <blueprintId>`, `kiln suggestions <entityId>`,
`kiln accept <suggestionId> [--ops 0,2]`. Enough to run the entire loop headless — this is
the MVP cut line.

---

## BP-5 — Local workspace app

**Requirement:** FRD-5 · **App:** `apps/desktop`

### Process model

Because `better-sqlite3` and the model key can't live in the webview, the desktop app is two
processes:

- **Node sidecar** — a compiled single-file binary running `core` + a local Hono API. This
  is the *same* host code a future self-host server would use. Registered as a Tauri v2
  sidecar, spawned at launch, bound to localhost.
- **Webview UI** — React + Vite, talking to the sidecar over localhost (typed client;
  TanStack Query for caching + optimistic accept/reject).

### UI surfaces

- **Feature-tree navigator** — nested requirements (`subtree`), opening requirement /
  blueprint / artifact documents.
- **Artifacts** — upload files; they become `artifact` entities available to `references`.
- **Document editor** — CodeMirror 6. Render pending suggestion ops as decorations: inserts
  green, deletes red strikethrough; accept/reject per op via the store's `applySuggestion`.
- **Work-order board** — columns by `WorkOrderStatus`; set `ready`, assign; each card shows
  its linked blueprint + requirement (via `assembleWorkOrderContext`).

The app contains **no product logic** — every action is a call into `core` through the
sidecar API.

## BP-6 — Production-ready workspace UI

**Requirement:** FRD-6 · **App:** `apps/desktop` (small additions to `packages/core` + sidecar)

### Design system

- **Tokens** in `apps/desktop/src/theme.ts` + CSS variables in `index.css`: the existing
  paper palette (`bg`, `surface`, `border`, `text`, `text-muted`, `accent`, `danger`, plus
  the four entity-type badge pairs), a 4px spacing grid, and a type scale
  (`xs 0.7rem / sm 0.8rem / base 0.9rem / lg 1.1rem`). No raw hex or ad-hoc `fontSize`
  outside this layer.
- **Primitives** in `apps/desktop/src/components/ui/`: `Button` (primary / ghost / danger),
  `Input`, `Select`, `Badge` (generalized from GraphPanel), `SectionHeader`, `RowMenu`
  (the ⋯ overflow menu), `Toast`. Plain React + inline styles reading tokens — no CSS
  framework dependency.

### App shell

Grid layout: a ~44px **top bar** row over the existing three columns (navigator | document |
graph panel). The top bar holds:

- **View switcher** — segmented control (Documents / Board), the only mode switch.
- **Quick-open** — a search affordance opening the ⌘K palette.
- **Status cluster** — sidecar health dot and model-credential dot with tooltips. `/health`
  gains `providerAvailable: boolean` (sidecar checks its provider config; no model call).
  Only failures demand attention; healthy states stay quiet.

The sidebar drops the brand header, status text, and tabs — it is only the navigator.

### Unified navigator

`featureTree` in core gains an opt-in expanded shape: each requirement node carries its
`details`-linked blueprints, and each blueprint its `implements`-linked work orders
(assembled in core — the webview never walks edges itself). Sidecar: `GET /tree?expand=chain`.
Tree UI: chevrons with expansion persisted to `localStorage`, type badges, hover states, a
per-row ⋯ menu (add child / rename / delete), a `+` in the section header replacing the
always-visible input. Artifacts remain a separate collapsible section with a count and a
styled upload button (no native file-input chrome).

### Interaction patterns

- **Rename** — click-to-edit on the document title (`PATCH` title); Enter commits, Esc
  cancels. Also available from the tree's row menu.
- **Breadcrumbs** — `GET /entities/:id/ancestors` (core `ancestors`) rendered as a
  clickable path above the document title.
- **Quick-open** — ⌘K palette; client-side fuzzy title filter over the four cached
  `listEntities` queries (FTS later if needed); Enter opens the entity in the right view.
- **Board** — columns shrink to fit the 1100px default window; cards are clickable and
  open the work order's document; the status `<select>` becomes a status pill + menu of
  the sidecar-provided transitions; blueprint/requirement lines become links.
- **Errors** — known sidecar failures (503 provider-unavailable, 502 authoring-failed,
  fetch failure) map to human copy in one place in the client; async outcomes surface as
  toasts, not layout-shifting inline text.

The **no product logic in the webview** rule is unchanged: tree shape, transitions, the
`details` 1:1 rule, and anchor policy all stay in core behind the sidecar.
