# Kiln — Work Orders

> **Progress: WO-01 … WO-16 are ALL complete and tested — the MVP is done.**
> Phase 1 proved the thesis (`docs/CONNECTING.md`), Phase 2 made it usable headless
> (agents + CLI), Phase 3 delivered the workspace app (navigator, suggestion editor,
> work-order board). Setting a work order ready on the board makes it appear in
> `list_ready_work_orders` over MCP — the full human-to-agent loop, in the UI. Do not re-implement completed work orders.
> **Phase 4 (WO-17 … WO-24, production polish) is COMPLETE — all 24 work orders are done.**


Units of work for a coding agent. Build in order; each lists its dependencies. **Status**
here is the *build* state for you, not the product's work-order status. Fields:

- **Requirement / Blueprint** — the linked docs that give the "what/why" and "how."
- **Depends on** — must be complete first.
- **Files** — primary paths to create or change.
- **Acceptance** — verifiable done-conditions (prefer: tests pass / command works).

> **How to use with Claude Code:** point it at this repo's `docs/` folder and instruct it to
> implement work orders in order, one at a time, reading the linked FRD and BP sections for
> each, and stopping after each for review. Start with **WO-01**.

---

## Phase 1 — Spine (build and prove first)

### WO-01 — Monorepo scaffold  — **DONE**
- **Requirement:** — · **Blueprint:** BP-0 · **Depends on:** —
- **Description:** Initialize the pnpm workspace and empty, buildable packages. No logic.
- **Files:** `pnpm-workspace.yaml`, `tsconfig.base.json`, `packages/core/package.json`,
  `packages/mcp-server/package.json`, tsup + vitest config.
- **Acceptance:**
  - `pnpm install` succeeds; `pnpm -r build` and `pnpm -r test` run (0 tests) with no errors.
  - `core` exports an empty `index.ts`; `mcp-server` has an empty entry.
- **Out of scope:** any domain code.

### WO-02 — Domain types + Zod schemas  — **DONE**
- **Requirement:** FRD-1 · **Blueprint:** BP-0 · **Depends on:** WO-01
- **Description:** Implement the domain types and edit model exactly as in BP-0.
- **Files:** `packages/core/src/domain/*`.
- **Acceptance:**
  - `Entity`, `Link`, `EntityType`, `LinkType`, `WorkOrderStatus` exported.
  - `EditOp` and `Suggestion` Zod schemas exported; unit tests confirm valid ops parse and
    malformed ops throw.

### WO-03 — Drizzle schema + migrations + connection  — **DONE (via node:sqlite)**
- **Requirement:** FRD-1 · **Blueprint:** BP-1 · **Depends on:** WO-02
- **Description:** Define `entities`, `links`, `suggestions`, `revisions`, and `entities_fts`
  tables; generate a migration; open a connection with WAL/foreign-keys/busy_timeout pragmas.
- **Files:** `packages/core/src/schema/*`, migration output, a `connect()` helper.
- **Acceptance:**
  - Running migrations against a fresh file creates all tables and the FTS5 virtual table.
  - `PRAGMA journal_mode` returns `wal`; `PRAGMA foreign_keys` returns `1`.

### WO-04 — `Store` interface + `SqliteStore`  — **DONE**
- **Requirement:** FRD-1 · **Blueprint:** BP-1 · **Depends on:** WO-03
- **Description:** Implement the full `Store` interface (BP-1) over SQLite, including the
  recursive-CTE `subtree`, both `linked`/`linkedFrom`, and FTS5 `searchArtifacts`.
- **Files:** `packages/core/src/store/*`.
- **Acceptance:**
  - CRUD, `link`/`unlink`, `linked`/`linkedFrom`, `children`, `subtree`,
    `workOrdersByStatus`, and `searchArtifacts` all covered by passing Vitest tests.
  - 1:1 rule: linking a second `details` edge from one blueprint is rejected at the app layer.
  - No Drizzle/`better-sqlite3` import exists outside `store/` and `schema/`.

### WO-05 — Context assembly + traversal  — **DONE**
- **Requirement:** FRD-2 · **Blueprint:** BP-2 · **Depends on:** WO-04
- **Description:** Implement `assembleWorkOrderContext`, `ancestors`, `descendants`.
- **Files:** `packages/core/src/graph/*`, fixtures.
- **Acceptance:**
  - Given a seeded `artifact→requirement→blueprint→work_order` chain,
    `assembleWorkOrderContext(woId)` returns all four correctly linked — asserted in tests.
  - Missing-link cases return typed partials (null blueprint/requirement, empty artifacts),
    not throws — asserted in tests.

### WO-06 — MCP server + tools + seed  — **DONE**
- **Requirement:** FRD-3 · **Blueprint:** BP-3 · **Depends on:** WO-05
- **Description:** Stand up the MCP server (streamable HTTP, bearer auth) exposing
  `list_ready_work_orders`, `get_work_order`, `update_work_order_status`; add a `seed` script.
- **Files:** `packages/mcp-server/src/*`, `packages/mcp-server/src/seed.ts`.
- **Acceptance:**
  - Server boots against a given SQLite path; all three tools are listed by an MCP client.
  - `get_work_order` returns the full `WorkOrderContext`; status transitions validate against
    the allowed set; unauthenticated calls are refused.
  - `seed` inserts a demo chain and prints a `ready` work order id.

### WO-07 — End-to-end verification + docs  — **DONE**
- **Requirement:** FRD-3 · **Blueprint:** BP-3 · **Depends on:** WO-06
- **Description:** Connect a real coding agent and run the loop; document the steps.
- **Files:** `docs/CONNECTING.md`.
- **Acceptance:**
  - Documented: register the server with Claude Code, then `list_ready_work_orders` →
    `get_work_order` (full context confirmed) → `update_work_order_status(id,"done")`.
  - After the run, the store reflects the work order as `done`.
  - **This closes Phase 1 and proves the thesis.**

---

## Phase 2 — Authoring (MVP cut line: usable headless after WO-12)

### WO-08 — `ModelProvider` + Anthropic impl + tiering  — **DONE**
- **Requirement:** FRD-4 · **Blueprint:** BP-4 · **Depends on:** WO-02
- **Files:** `packages/agents/src/model/*`.
- **Acceptance:**
  - `ModelProvider` interface + `AnthropicModelProvider`; tier→model map from config.
  - Structured output returned via a single "emit" tool; a smoke test round-trips a small
    structured response. Key read only from env in the host.

### WO-09 — Edit-application engine + revisions  — **DONE**
- **Requirement:** FRD-4 · **Blueprint:** BP-4 · **Depends on:** WO-04
- **Files:** `packages/core/src/edits/*`.
- **Acceptance:**
  - `applySuggestion(store, suggestionId, acceptedOpIndexes)` applies accepted ops in order,
    updates the entity, appends one `revision`; atomic on failure — tested.
  - Per-op accept/reject verified (accept a subset, confirm resulting body + revision).

### WO-10 — Drafting agent  — **DONE**
- **Requirement:** FRD-4 · **Blueprint:** BP-4 · **Depends on:** WO-08, WO-09
- **Files:** `packages/agents/src/draft/*`, default templates.
- **Acceptance:**
  - Given a target entity + referenced artifacts + template, returns a Zod-valid `Suggestion`
    of `EditOp[]`; malformed model output is rejected and retried.
  - Draft is template-driven (swapping the template changes structure) — demonstrated.

### WO-11 — Work-order extraction agent  — **DONE**
- **Requirement:** FRD-4 · **Blueprint:** BP-4 · **Depends on:** WO-10
- **Files:** `packages/agents/src/extract/*`.
- **Acceptance:**
  - Given a blueprint, returns candidate work orders as a suggestion set.
  - Accepting a candidate creates a `work_order` and links it `implements → blueprint` —
    tested end-to-end against the store.

### WO-12 — Authoring CLI  — **DONE**
- **Requirement:** FRD-4 · **Blueprint:** BP-4 · **Depends on:** WO-11
- **Files:** `packages/cli/src/*`.
- **Acceptance:**
  - `kiln draft`, `kiln extract`, `kiln suggestions`, `kiln accept [--ops …]` all work
    against a local store.
  - A scripted run authors a requirement, drafts a blueprint, extracts a work order, sets it
    `ready`, and it then appears in `list_ready_work_orders` over MCP.
  - **MVP is now fully usable headless.**

---

## Phase 3 — Workspace app

### WO-13 — Tauri app + Node sidecar + local API  — **DONE**
- **Requirement:** FRD-5 · **Blueprint:** BP-5 · **Depends on:** WO-05 (WO-12 recommended)
- **Files:** `apps/desktop/*` (Tauri v2), sidecar build, Hono API + typed client.
- **Acceptance:**
  - App launches; sidecar (compiled binary running `core` + Hono) starts and binds localhost.
  - UI performs a round-trip read (e.g. list requirements) through the sidecar; no product
    logic in the webview.

### WO-14 — Feature-tree navigator + document view + artifacts  — **DONE**
- **Requirement:** FRD-5 · **Blueprint:** BP-5 · **Depends on:** WO-13
- **Acceptance:**
  - Navigator renders the nested feature tree; opening a node shows its document.
  - Artifacts can be uploaded and appear as referenceable entities.

### WO-15 — Editor with suggestion decorations  — **DONE**
- **Requirement:** FRD-5 · **Blueprint:** BP-5 · **Depends on:** WO-14, WO-09
- **Acceptance:**
  - CodeMirror 6 renders pending ops: inserts green, deletes red strikethrough.
  - Accept/reject per op calls `applySuggestion`; the document and revision history update
    with optimistic UI.

### WO-16 — Work-order board  — **DONE**
- **Requirement:** FRD-5 · **Blueprint:** BP-5 · **Depends on:** WO-14
- **Acceptance:**
  - Columns by status; set `ready` and assign from the UI.
  - Each card shows its linked blueprint + requirement via `assembleWorkOrderContext`.
  - Setting a work order `ready` makes it appear in the MCP `list_ready_work_orders` — the
    full human-to-agent loop, in the UI.

---

## Phase 4 — Production polish (FRD-6 / BP-6)

> UI-focused: `apps/desktop` throughout, with small, named additions to core and the
> sidecar. Acceptance for visual work = typecheck + existing tests green + the specific
> behaviors below verified in the running app (this host has no model credentials, so
> agent-dependent paths are verified via their error handling).

### WO-17 — Design tokens + UI primitives  — **DONE**
- **Requirement:** FRD-6 · **Blueprint:** BP-6 · **Depends on:** WO-16
- **Description:** Extract the token layer and primitive components; sweep every existing
  component onto them. Pure refactor — no layout or behavior changes.
- **Files:** `apps/desktop/src/theme.ts`, `apps/desktop/src/index.css`,
  `apps/desktop/src/components/ui/*`, all existing components.
- **Acceptance:**
  - No raw hex color or ad-hoc `fontSize` outside the token layer (grep-verifiable).
  - All buttons/inputs/selects render via primitives; the native file input is replaced
    with a styled upload button.
  - `pnpm -C apps/desktop test` and typecheck pass; app visually intact in dev.
- **Out of scope:** any IA/layout change.

### WO-18 — App shell: top bar + status cluster  — **DONE**
- **Requirement:** FRD-6 · **Blueprint:** BP-6 · **Depends on:** WO-17
- **Description:** Add the top bar (view switcher, quick-open affordance, status dots);
  strip brand/status/tabs from the sidebar. Sidecar `/health` gains `providerAvailable`.
- **Files:** `apps/desktop/src/components/TopBar.tsx`, `App.tsx`, `sidecar/api.ts`,
  `sidecar/api.test.ts`, `src/lib/client.ts`.
- **Acceptance:**
  - Documents/Board switching lives only in the top bar; sidebar contains only navigator
    content.
  - Sidecar down → red dot + tooltip; provider unavailable → amber dot (true on this host).
  - `api.test.ts` asserts the extended `/health` payload.

### WO-19 — Unified navigator  — **DONE**
- **Requirement:** FRD-6 · **Blueprint:** BP-6 · **Depends on:** WO-18
- **Description:** Requirements spine with nested blueprints/work orders (type-badged),
  chevrons with persisted expansion, hover states, row ⋯ menu (add child / rename /
  delete), header `+` for new requirements, collapsible Artifacts section with count.
- **Files:** `packages/core/src/graph/tree.ts` (+tests), `sidecar/api.ts` (`/tree?expand=chain`),
  `apps/desktop/src/components/FeatureTree.tsx`, `ArtifactsPanel.tsx`.
- **Acceptance:**
  - Blueprints and work orders appear nested under their requirements; clicking opens the
    document view. Core tests cover the expanded tree shape.
  - Expansion state survives app reload; add-child/rename/delete work from the tree.
- **Out of scope:** quick-open, breadcrumbs.

### WO-20 — Rename + breadcrumbs  — **DONE**
- **Requirement:** FRD-6 · **Blueprint:** BP-6 · **Depends on:** WO-19
- **Description:** Click-to-edit document titles; ancestor breadcrumb path above the title.
- **Files:** `sidecar/api.ts` (`/entities/:id/ancestors`), `DocumentView.tsx`, client.
- **Acceptance:**
  - Title edit commits on Enter, cancels on Esc, persists, and updates the tree.
  - A nested sub-requirement shows its full clickable `child_of` path.

### WO-21 — Board polish  — **DONE**
- **Requirement:** FRD-6 · **Blueprint:** BP-6 · **Depends on:** WO-18
- **Description:** Fit all five columns at the 1100px default; make cards open their work
  order's document; replace the status `<select>` with a status pill + transition menu;
  link the blueprint/requirement lines; add per-column empty hints.
- **Files:** `apps/desktop/src/components/Board.tsx`, `App.tsx` (selection wiring).
- **Acceptance:**
  - The Cancelled column is visible at 1100×760 without horizontal cutoff.
  - Clicking a card (or its context links) navigates to the entity's document.
  - Transitions offered still come only from `GET /entities/:id/transitions`.

### WO-22 — Quick-open (⌘K)  — **DONE**
- **Requirement:** FRD-6 · **Blueprint:** BP-6 · **Depends on:** WO-18
- **Description:** Command palette over all four entity types: fuzzy title filter,
  keyboard navigation, type badges; Enter opens the entity in the right view.
- **Files:** `apps/desktop/src/components/QuickOpen.tsx`, `TopBar.tsx`, `App.tsx`.
- **Acceptance:**
  - ⌘K opens the palette from either view; typing filters across types; Enter opens;
    Esc closes; arrow keys move the selection.

### WO-23 — Workflow completion: blueprint creation, empty states, friendly errors  — **DONE**
- **Requirement:** FRD-6 · **Blueprint:** BP-6 · **Depends on:** WO-20
- **Description:** "New blueprint" action on a requirement's graph panel (creates +
  links `details`, 1:1 enforced by core); zero-state CTA for a fresh DB; centralized
  error copy + toasts for async outcomes.
- **Files:** `GraphPanel.tsx`, `src/lib/errors.ts`, `src/components/ui/Toast.tsx`,
  `DocumentView.tsx`, `App.tsx`.
- **Acceptance:**
  - Creating a blueprint from a requirement links it `details` correctly and opens it. A
    requirement may hold several blueprints — core's 1:1 rule constrains the *blueprint*
    side (a blueprint cannot detail a second requirement), and any core rejection
    surfaces as a toast with core's own message, never a webview check. *(Amended from
    the original text, which mis-stated the rule's direction.)*
  - Fresh DB shows a "create your first requirement" CTA.
  - Draft/extract without credentials shows the friendly message, not `ApiError: …`.

### WO-24 — Revision diffs + restore  — **DONE**
- **Requirement:** FRD-6 · **Blueprint:** BP-6 · **Depends on:** WO-20
- **Description:** Selecting a revision shows a body diff against the current document;
  a Restore action writes via `commitBody` (unaffected by anchor lock) and appends a
  new revision.
- **Files:** `DocumentView.tsx` (+ a diff view component), sidecar route if needed.
- **Acceptance:**
  - Diff renders insertions/deletions distinctly (reuse of the editor's decoration
    styling is acceptable); restore round-trips and appends exactly one revision.
